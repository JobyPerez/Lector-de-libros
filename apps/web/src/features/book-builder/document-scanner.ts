export type ScanPoint = {
  x: number;
  y: number;
};

export type ScanQualityIssue = "blur" | "dark" | "low-resolution" | "overexposed";

export type PreparedDocumentScan = {
  corners: [ScanPoint, ScanPoint, ScanPoint, ScanPoint];
  detected: boolean;
  issues: ScanQualityIssue[];
  source: HTMLCanvasElement;
};

type OpenCvRuntime = typeof import("@techstark/opencv-js");

let openCvPromise: Promise<OpenCvRuntime> | null = null;

function unwrapOpenCvRuntime(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object" || !("default" in current)) break;
    const nested = current.default;
    if (!nested || nested === current) break;
    current = nested;
  }
  return current;
}

function waitForOpenCvRuntime(runtime: OpenCvRuntime): Promise<OpenCvRuntime> {
  if (runtime.Mat) {
    return Promise.resolve(runtime);
  }

  return new Promise((resolve) => {
    runtime.onRuntimeInitialized = () => resolve(runtime);
  });
}

async function loadOpenCv(): Promise<OpenCvRuntime> {
  if (!openCvPromise) {
    openCvPromise = import("@techstark/opencv-js")
      .then(async (module) => {
        const candidate = unwrapOpenCvRuntime(module.default);
        if (candidate instanceof Promise) {
          return waitForOpenCvRuntime(unwrapOpenCvRuntime(await candidate) as OpenCvRuntime);
        }

        return waitForOpenCvRuntime(candidate as OpenCvRuntime);
      })
      .catch(() => {
        openCvPromise = null;
        throw new Error("No se pudo cargar el escáner. Actualiza la página y vuelve a intentarlo.");
      });
  }

  return openCvPromise;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("No se pudo abrir la imagen para escanearla."));
    };
    image.src = objectUrl;
  });
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

async function fileToCanvas(file: File) {
  const image = await loadImage(file);
  const scale = Math.min(1, 4000 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = createCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("El navegador no pudo preparar la imagen.");
  }

  context.drawImage(image, 0, 0);
  return canvas;
}

function pointDistance(left: ScanPoint, right: ScanPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function orderCorners(points: ScanPoint[]): [ScanPoint, ScanPoint, ScanPoint, ScanPoint] {
  if (points.length !== 4) {
    throw new Error("El marco de la página debe tener cuatro esquinas.");
  }
  const center = points.reduce((result, point) => ({ x: result.x + point.x / 4, y: result.y + point.y / 4 }), { x: 0, y: 0 });
  const sorted = [...points].sort((left, right) => (
    Math.atan2(left.y - center.y, left.x - center.x) - Math.atan2(right.y - center.y, right.x - center.x)
  ));
  const topLeftIndex = sorted.reduce((bestIndex, point, index) => (
    point.x + point.y < (sorted[bestIndex]?.x ?? 0) + (sorted[bestIndex]?.y ?? 0) ? index : bestIndex
  ), 0);
  const ordered = [...sorted.slice(topLeftIndex), ...sorted.slice(0, topLeftIndex)];
  return [ordered[0] as ScanPoint, ordered[1] as ScanPoint, ordered[2] as ScanPoint, ordered[3] as ScanPoint];
}

function polygonArea(points: ScanPoint[]) {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length] as ScanPoint;
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function validateCorners(points: [ScanPoint, ScanPoint, ScanPoint, ScanPoint], source: HTMLCanvasElement) {
  const minimumDistance = Math.max(source.width, source.height) * 0.015;
  for (let index = 0; index < points.length; index += 1) {
    if (pointDistance(points[index] as ScanPoint, points[(index + 1) % points.length] as ScanPoint) < minimumDistance) {
      throw new Error("Hay dos esquinas demasiado juntas. Ajusta el marco y vuelve a intentarlo.");
    }
  }
  if (polygonArea(points) < source.width * source.height * 0.008) {
    throw new Error("El marco es demasiado pequeño. Ajusta las cuatro esquinas y vuelve a intentarlo.");
  }
  const crossProducts = points.map((point, index) => {
    const next = points[(index + 1) % points.length] as ScanPoint;
    const following = points[(index + 2) % points.length] as ScanPoint;
    return (next.x - point.x) * (following.y - next.y) - (next.y - point.y) * (following.x - next.x);
  });
  if (!crossProducts.every((value) => value > 0) && !crossProducts.every((value) => value < 0)) {
    throw new Error("Las esquinas forman un marco cruzado. Colócalas alrededor de la página y vuelve a intentarlo.");
  }
}

function defaultCorners(width: number, height: number): [ScanPoint, ScanPoint, ScanPoint, ScanPoint] {
  const insetX = Math.max(1, width * 0.045);
  const insetY = Math.max(1, height * 0.045);
  return [
    { x: insetX, y: insetY },
    { x: width - insetX, y: insetY },
    { x: width - insetX, y: height - insetY },
    { x: insetX, y: height - insetY }
  ];
}

function detectQualityIssues(cv: OpenCvRuntime, gray: InstanceType<OpenCvRuntime["Mat"]>, source: HTMLCanvasElement) {
  const issues: ScanQualityIssue[] = [];
  const mean = cv.mean(gray)[0] ?? 128;
  const laplacian = new cv.Mat();
  const laplacianMean = new cv.Mat();
  const standardDeviation = new cv.Mat();
  let sharpness = 0;
  try {
    cv.Laplacian(gray, laplacian, cv.CV_64F);
    cv.meanStdDev(laplacian, laplacianMean, standardDeviation);
    const deviation = standardDeviation.doubleAt(0, 0);
    sharpness = deviation * deviation;
  } finally {
    laplacian.delete();
    laplacianMean.delete();
    standardDeviation.delete();
  }

  if (source.width < 1100 || source.height < 1100) issues.push("low-resolution");
  if (sharpness < 65) issues.push("blur");
  if (mean < 72) issues.push("dark");
  if (mean > 222) issues.push("overexposed");
  return issues;
}

export async function analyzeDocumentCanvas(source: HTMLCanvasElement): Promise<PreparedDocumentScan> {
  const cv = await loadOpenCv();
  const analysisScale = Math.min(1, 1200 / Math.max(source.width, source.height));
  const analysisCanvas = createCanvas(source.width * analysisScale, source.height * analysisScale);
  const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
  if (!analysisContext) {
    throw new Error("El navegador no pudo analizar la imagen.");
  }
  analysisContext.drawImage(source, 0, 0, analysisCanvas.width, analysisCanvas.height);

  const input = cv.imread(analysisCanvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const closedEdges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  let bestPoints: ScanPoint[] | null = null;
  let bestArea = 0;

  try {
    cv.cvtColor(input, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 55, 165);
    cv.morphologyEx(edges, closedEdges, cv.MORPH_CLOSE, kernel);
    cv.findContours(closedEdges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minimumArea = analysisCanvas.width * analysisCanvas.height * 0.16;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new cv.Mat();
      try {
        const area = Math.abs(cv.contourArea(contour));
        if (area <= minimumArea || area <= bestArea) continue;

        cv.approxPolyDP(contour, approximation, cv.arcLength(contour, true) * 0.025, true);
        if (approximation.rows !== 4 || !cv.isContourConvex(approximation)) continue;

        const points: ScanPoint[] = [];
        for (let pointIndex = 0; pointIndex < 4; pointIndex += 1) {
          points.push({
            x: (approximation.data32S[pointIndex * 2] ?? 0) / analysisScale,
            y: (approximation.data32S[pointIndex * 2 + 1] ?? 0) / analysisScale
          });
        }
        bestArea = area;
        bestPoints = points;
      } finally {
        approximation.delete();
        contour.delete();
      }
    }

    return {
      corners: bestPoints ? orderCorners(bestPoints) : defaultCorners(source.width, source.height),
      detected: bestPoints !== null,
      issues: detectQualityIssues(cv, gray, source),
      source
    };
  } finally {
    input.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    closedEdges.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

export async function prepareDocumentScan(file: File) {
  return analyzeDocumentCanvas(await fileToCanvas(file));
}

export async function rotateDocumentCanvas(source: HTMLCanvasElement, direction: -1 | 1) {
  const rotated = createCanvas(source.height, source.width);
  const context = rotated.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("No se pudo girar la imagen.");
  }

  if (direction === 1) {
    context.translate(rotated.width, 0);
    context.rotate(Math.PI / 2);
  } else {
    context.translate(0, rotated.height);
    context.rotate(-Math.PI / 2);
  }
  context.drawImage(source, 0, 0);
  return analyzeDocumentCanvas(rotated);
}

function applyGentleAutoContrast(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < imageData.data.length; index += 16) {
    const luminance = Math.round(
      (imageData.data[index] ?? 0) * 0.2126
      + (imageData.data[index + 1] ?? 0) * 0.7152
      + (imageData.data[index + 2] ?? 0) * 0.0722
    );
    histogram[luminance] = (histogram[luminance] ?? 0) + 1;
  }

  const sampleCount = Math.ceil(imageData.data.length / 16);
  const lowerTarget = sampleCount * 0.015;
  const upperTarget = sampleCount * 0.985;
  let cumulative = 0;
  let lower = 0;
  let upper = 255;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value] ?? 0;
    if (cumulative <= lowerTarget) lower = value;
    if (cumulative < upperTarget) upper = value;
  }

  if (upper - lower < 45 || (lower < 8 && upper > 247)) return;
  const correction = 255 / (upper - lower);
  for (let index = 0; index < imageData.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const original = imageData.data[index + channel] ?? 0;
      const adjusted = Math.max(0, Math.min(255, (original - lower) * correction));
      imageData.data[index + channel] = Math.round(original * 0.58 + adjusted * 0.42);
    }
  }
  context.putImageData(imageData, 0, 0);
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("No se pudo generar la imagen corregida."));
    }, "image/jpeg", 0.92);
  });
}

export async function renderDocumentScan(source: HTMLCanvasElement, inputCorners: ScanPoint[], fileName: string) {
  const cv = await loadOpenCv();
  const [topLeft, topRight, bottomRight, bottomLeft] = orderCorners(inputCorners);
  validateCorners([topLeft, topRight, bottomRight, bottomLeft], source);
  const rawWidth = Math.max(pointDistance(topLeft, topRight), pointDistance(bottomLeft, bottomRight));
  const rawHeight = Math.max(pointDistance(topLeft, bottomLeft), pointDistance(topRight, bottomRight));
  if (rawWidth < 80 || rawHeight < 80) {
    throw new Error("El marco es demasiado pequeño. Separa las cuatro esquinas y vuelve a intentarlo.");
  }
  const outputScale = Math.min(1, 3200 / Math.max(rawWidth, rawHeight));
  const width = Math.max(1, Math.round(rawWidth * outputScale));
  const height = Math.max(1, Math.round(rawHeight * outputScale));
  const input = cv.imread(source);
  const output = new cv.Mat();
  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    topLeft.x, topLeft.y,
    topRight.x, topRight.y,
    bottomRight.x, bottomRight.y,
    bottomLeft.x, bottomLeft.y
  ]);
  const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    width - 1, 0,
    width - 1, height - 1,
    0, height - 1
  ]);
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const outputCanvas = createCanvas(width, height);

  try {
    cv.warpPerspective(
      input,
      output,
      transform,
      new cv.Size(width, height),
      cv.INTER_CUBIC,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255)
    );
    cv.imshow(outputCanvas, output);
  } finally {
    input.delete();
    output.delete();
    sourcePoints.delete();
    destinationPoints.delete();
    transform.delete();
  }

  applyGentleAutoContrast(outputCanvas);
  const blob = await canvasToBlob(outputCanvas);
  const baseName = fileName.replace(/\.[^.]+$/u, "") || "pagina";
  return new File([blob], `${baseName}-escaneada.jpg`, { type: "image/jpeg" });
}
