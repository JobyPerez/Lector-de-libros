# Exportacion PDF OCR

El PDF OCR utiliza Chromium con Playwright para conservar el HTML y la
maquetacion del lector. Cada pagina del libro ocupa una hoja A4; se reduce
proporcionalmente cuando es necesario, sin separar columnas ni rasterizar el
texto. Portada e indice, si existen, ocupan hojas independientes.

La composicion usa un ancho de escritorio estable de 900 px, independiente del
movil o del navegador desde el que se descarga. Los estilos de columnas se
comparten con el lector en
`apps/web/src/features/reader/reading-document.css`. Este fichero debe estar
disponible tambien en produccion junto con el build de la API.

## Instalacion

Despues de instalar dependencias, y cada vez que se actualice Playwright,
instalar el navegador con el mismo usuario que ejecuta la API:

```bash
npm run install:pdf-browser --workspace @lector/api
```

En sistemas sin las bibliotecas necesarias, el administrador debe instalar
las dependencias de Chromium mediante `npx playwright install-deps chromium`.
Opcionalmente, `PDF_CHROMIUM_EXECUTABLE_PATH` permite indicar un ejecutable
compatible en lugar del navegador instalado por Playwright.

El proceso se ejecuta sin sandbox por las restricciones del servidor actual.
Por ello se deshabilita JavaScript de los documentos y se bloquean peticiones
de red. Las imagenes del libro se hidratan como URLs de datos antes de exportar.

La exportacion EPUB y el PDF de imagenes siguen utilizando sus motores
anteriores y no cambian con esta implementacion.
