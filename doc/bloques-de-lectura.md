# Bloques y elementos de lectura

La interfaz actual se describe en [Editor visual de paginas](editor-visual.md). Este documento conserva el contrato heredado de marcadores y las fases anteriores; la lista inferior y sus controles de dividir/unir ya no forman parte del nuevo editor visual.

## Uso

- Los libros OCR (`IMAGES`) ofrecen las vistas Adaptable y Original. PDF y EPUB no muestran ese selector. Original requiere una imagen fuente de la pagina.
- Adaptable muestra bloques sin etiquetas visibles de numeracion; los encabezados del contenido se conservan. El editor si muestra los numeros para ajustar el orden de narracion.
- Editar esta pagina abre la revision: cada bloque admite varios parrafos, titulos e imagenes. Subir/Bajar mueve todo su contenido.
- Para dividir, colocar el cursor al principio del parrafo que debe abrir el siguiente bloque y pulsar Dividir desde cursor. Unir siguiente agrupa bloques contiguos.
- Los cambios de texto, agrupacion y orden se aplican al guardar. El lector utiliza los parrafos regenerados en ese mismo orden.
- El OCR visual propone agrupaciones semanticas; AWS/Textract agrupa usando las cajas de Layout, incluidos parrafos, titulos, listas e imagenes. Ambos pueden proponer filas horizontales. Las paginas existentes no se reprocesan automaticamente: se pueden dividir manualmente o volver a ejecutar el OCR correspondiente desde la revision.

## Elementos visibles y narracion

- Cada elemento tiene un tipo independiente de su opcion Leer en voz alta: Cabecera, Cuerpo, Titulo, Imagen, Pie de imagen, Pie de pagina o Numero de pagina.
- Desmarcar Leer en voz alta no oculta ni elimina contenido. Conserva los IDs, las anotaciones y las posiciones de los parrafos. El aviso No se lee solo aparece en el editor.
- En los nuevos OCR, cabeceras, pies de pagina y numeros se proponen sin narracion. Los titulos del contenido y pies de imagen son categorias distintas y se leen inicialmente. Las paginas anteriores conservan su comportamiento hasta que se editen explicitamente.
- Seleccionar un elemento en la previsualizacion o en sus controles selecciona su zona en la imagen de trabajo, y viceversa. Marcar zona en original permite dibujar una caja cuando no existe geometria OCR; ese control se refiere a la imagen utilizada por la revision.
- La narracion del dispositivo y Deepgram omiten los elementos excluidos, saltan paginas sin contenido narrable y se detienen al final. Reproducir sobre un elemento excluido empieza en el siguiente narrable.
- Las estimaciones de tiempo y coste, los bloques de audio y las descargas offline consideran solo contenido narrable. Los conteos y el progreso visuales conservan las posiciones del libro completo.
- Las columnas adaptables aprovechan las proporciones y separaciones del OCR. Las imagenes usan su ancho relativo cuando hay geometria; sin ella se conserva la disposicion anterior. El texto fluye sin posicionamiento absoluto para evitar solapamientos al ampliar o corregirlo.

## Persistencia

`edited_text` conserva marcadores de linea `:::block ID`; el ID admite letras ASCII, numeros, guion y guion bajo, hasta 80 caracteres. El HTML representa cada agrupacion con `section.reader-reading-block` y atributos `data-reading-block-id` y `data-reading-block-number`. Los parrafos mantienen su numeracion continua para voz y anotaciones. Una pagina sin marcadores forma un unico bloque.

El marcador extendido es `:::block ID row=ROW_ID`; `row` es opcional y usa las mismas restricciones ASCII de 1 a 80 caracteres. No cuenta como parrafo. Los bloques contiguos de una fila se envuelven en `div.reader-reading-row` con `data-reading-row-id`, tambien presente en sus secciones. La conversion HTML a texto conserva esta metadata. La vista previa muestra columnas iguales y de igual altura en escritorio y las apila en movil, manteniendo las etiquetas del editor.

En cada bloque, marcar Junto al anterior crea una fila con UUID si el precedente no tiene fila, o reutiliza la suya. Desmarcar lo separa en vertical. Dividir hereda la fila en ambas partes; Unir siguiente conserva la fila del bloque anterior. Tras agrupar, separar, mover, eliminar, dividir o unir, cada recurrencia no contigua de una fila recibe un UUID nuevo para todo ese segmento: nunca se colapsan segmentos separados por compartir ID. Las identidades de bloques, parrafos e imagenes no cambian al normalizar filas.

El PUT de OCR acepta `paragraphIds` y `paragraphMetadata` opcionales alineados con todos los elementos de contenido, incluidos los no narrables y sin contar los marcadores. Las identidades pertenecen a la pagina y no pueden repetirse. Al mover bloques se conservan anotaciones y se remapea el progreso; las correspondencias ambiguas recurren al matching existente. Una desalineacion del borrador con metadatos persistidos bloquea el guardado en lugar de reactivar narracion silenciosamente.

Una desalineacion del texto editable no impide volver a ejecutar el OCR: esa operacion utiliza la imagen fuente y puede recuperar una pagina incoherente. Los conflictos de version, los guardados parciales y las operaciones OCR ya activas siguen bloqueando el reintento para evitar sobrescrituras.

SQL034 agrega `element_role`, `read_aloud` y `geometry_json` a `book_paragraphs`. Su script idempotente es `apps/api/src/scripts/migrate-page-elements.ts`. La geometria es `{ bbox: { left, top, width, height } }`, normalizada a la imagen de trabajo utilizada por el OCR.

`PATCH /books/:bookId/pages/:pageNumber/elements` actualiza solo metadatos con `elements` y `expectedUpdatedAt`. El editor usa ese endpoint cuando no cambia texto. PUT de OCR y upload de imagen tambien admiten el guard de version; devuelven la nueva version para encadenar cambios sin adoptar mediante un GET una edicion remota desconocida. Un conflicto devuelve 409. Si la imagen se guarda pero falla el siguiente paso, el editor informa guardado parcial y conserva el borrador.

Las revisiones del libro usan timestamps UTC con seis decimales. La cache offline normaliza revisiones antiguas de tres decimales e impide que una pestana obsoleta rebaje la revision o repueble audio descartado. TTS comunica las secuencias reales y el cursor `X-Reader-Tts-Next-Sequence`, sin asumir que los parrafos narrables sean contiguos.

Las referencias heredadas a imagenes se resuelven antes de guardar y externalizar. El cliente compacta las imagenes base64 persistidas usando su posicion en el HTML guardado, no su nueva posicion visual.

La migracion `apps/api/sql/033_original_page_images.sql` admite snapshots `ORIGINAL_PAGE_IMAGE` y asegura uno por libro e imagen fuente. Ejecutar el script `apps/api/src/scripts/migrate-original-page-images.ts` con `tsx` y la configuracion del entorno. El PUT de imagen preserva los bytes anteriores antes de la primera modificacion; `GET .../image?original=true` usa ese snapshot o, si no existe, la fuente actual. No es posible recuperar originales que se sobrescribieron antes de esta funcionalidad.

Las revisiones de contenido invalidan el audio offline del libro y la cola de reproduccion. Una descarga de una revision anterior no puede repoblar la cache de una revision nueva.

## Limites

- La agrupacion AWS es geometrica y heuristica: permite revisar y corregir los resultados manualmente. Titulos transversales y margenes separan bandas de columnas. Si la geometria es insuficiente, se conserva el orden AWS sin inventar filas.
- Los bloques de una fila se muestran en paralelo, con igual altura en escritorio, y se apilan en movil. La voz sigue el orden guardado, completando un bloque antes del siguiente; no lee por lineas alternadas entre columnas.
- Las zonas del editor corresponden a la imagen de trabajo, no necesariamente al snapshot original si se ha recortado. Recortar, sustituir o rotar la imagen invalida las cajas, conservando roles y flags; despues pueden marcarse nuevas zonas o repetir el OCR.
- No se incluye reconstruccion exacta del diseno, estilos de color/fondo/bordes ni tratamiento especifico de marcadores de listas.
- Los bloques se reordenan con botones accesibles, no mediante arrastre.
- Las imagenes se amplian con el visor existente. La vista Original no resalta zonas durante la narracion; la voz sigue el orden adaptable.

## Verificacion

- `npm run typecheck`
- `npm test --workspace @lector/api`
- `npm test --workspace @lector/web`

Las pruebas de frontend usan `jsdom` para conversiones de contenido y `fake-indexeddb` para invalidacion y concurrencia de audio, declarados como dependencias de desarrollo.
