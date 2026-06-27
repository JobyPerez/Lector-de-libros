type ZipInputFile = {
  data: Blob | Uint8Array | string;
  name: string;
};

type PreparedZipFile = {
  compressedSize: number;
  crc32: number;
  data: Uint8Array;
  dosDate: number;
  dosTime: number;
  name: Uint8Array;
  offset: number;
  uncompressedSize: number;
};

const textEncoder = new TextEncoder();
const crc32Table = createCrc32Table();

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function computeCrc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (crc32Table[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

async function toBytes(data: ZipInputFile["data"]) {
  if (typeof data === "string") {
    return textEncoder.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(await data.arrayBuffer());
}

function createLocalHeader(file: PreparedZipFile) {
  const header = new Uint8Array(30 + file.name.length);
  writeUint32(header, 0, 0x04034b50);
  writeUint16(header, 4, 20);
  writeUint16(header, 6, 0x0800);
  writeUint16(header, 8, 0);
  writeUint16(header, 10, file.dosTime);
  writeUint16(header, 12, file.dosDate);
  writeUint32(header, 14, file.crc32);
  writeUint32(header, 18, file.compressedSize);
  writeUint32(header, 22, file.uncompressedSize);
  writeUint16(header, 26, file.name.length);
  writeUint16(header, 28, 0);
  header.set(file.name, 30);
  return header;
}

function createCentralDirectoryHeader(file: PreparedZipFile) {
  const header = new Uint8Array(46 + file.name.length);
  writeUint32(header, 0, 0x02014b50);
  writeUint16(header, 4, 20);
  writeUint16(header, 6, 20);
  writeUint16(header, 8, 0x0800);
  writeUint16(header, 10, 0);
  writeUint16(header, 12, file.dosTime);
  writeUint16(header, 14, file.dosDate);
  writeUint32(header, 16, file.crc32);
  writeUint32(header, 20, file.compressedSize);
  writeUint32(header, 24, file.uncompressedSize);
  writeUint16(header, 28, file.name.length);
  writeUint16(header, 30, 0);
  writeUint16(header, 32, 0);
  writeUint16(header, 34, 0);
  writeUint16(header, 36, 0);
  writeUint32(header, 38, 0);
  writeUint32(header, 42, file.offset);
  header.set(file.name, 46);
  return header;
}

function createEndOfCentralDirectory(fileCount: number, centralDirectorySize: number, centralDirectoryOffset: number) {
  const header = new Uint8Array(22);
  writeUint32(header, 0, 0x06054b50);
  writeUint16(header, 4, 0);
  writeUint16(header, 6, 0);
  writeUint16(header, 8, fileCount);
  writeUint16(header, 10, fileCount);
  writeUint32(header, 12, centralDirectorySize);
  writeUint32(header, 16, centralDirectoryOffset);
  writeUint16(header, 20, 0);
  return header;
}

export async function createStoredZip(files: ZipInputFile[]) {
  const { dosDate, dosTime } = getDosDateTime();
  let offset = 0;
  const preparedFiles: PreparedZipFile[] = [];

  for (const file of files) {
    const data = await toBytes(file.data);
    const name = textEncoder.encode(file.name.replace(/^\/+|\0/gu, ""));
    const preparedFile = {
      compressedSize: data.length,
      crc32: computeCrc32(data),
      data,
      dosDate,
      dosTime,
      name,
      offset,
      uncompressedSize: data.length
    };
    offset += 30 + name.length + data.length;
    preparedFiles.push(preparedFile);
  }

  const localParts = preparedFiles.flatMap((file) => [createLocalHeader(file), file.data]);
  const centralDirectoryOffset = offset;
  const centralParts = preparedFiles.map(createCentralDirectoryHeader);
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = createEndOfCentralDirectory(preparedFiles.length, centralDirectorySize, centralDirectoryOffset);
  const blobParts = [...localParts, ...centralParts, endRecord].map((part) => {
    const copy = new Uint8Array(part.length);
    copy.set(part);
    return copy.buffer;
  });

  return new Blob(blobParts, { type: "application/zip" });
}
