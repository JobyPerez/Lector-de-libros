# Editor visual de paginas

## Uso

La imagen de trabajo y el contenido importado son la superficie de origen. La previsualizacion interactiva de la derecha representa el documento reconstruido. Seleccionar una zona o un bloque abre su inspector debajo del origen; en movil se abre un dialogo.

- Texto: contenido Markdown, negrita, cursiva, listas, alineacion y escala de fuente. Varias lineas siguen perteneciendo al mismo bloque.
- Titulo: niveles T1 a T6 y opcion independiente Incluir en el indice. Las cabeceras, pies y numeros de pagina no entran en el indice aunque visualmente sean titulos.
- Imagen: descripcion, ancho relativo a su contenedor y alineacion. Ampliar es una accion separada; pulsar la imagen selecciona el inspector.
- Todos: funcion, Leer en voz alta, Anular y Numero / orden. Anular es reversible mediante Mostrar anulados y conserva la fuente original, identidades y anotaciones.

La lista inferior de Bloques de lectura se sustituye por este inspector. No hay escritura automatica: las modificaciones se reflejan inmediatamente en la previsualizacion, pero solo Guardar cambios las aplica al libro. Deshacer/Rehacer actuan sobre el borrador, incluidas anulaciones y movimientos; no sustituyen un historial de versiones guardadas.

## Unir contenido

Seleccion multiple permite seleccionar zonas en la imagen o bloques en la previsualizacion; Ctrl/Cmd+clic tambien suma o quita seleccion. Unir seleccionados abre un dialogo con tipo, separacion, nivel de titulo e inclusion en el indice. Se admite texto/titulo activo y consecutivo de la misma pagina; las imagenes y los compuestos existentes requieren otra operacion o separar primero.

El titulo se propone con salto de linea y el cuerpo con separacion de parrafos. Espacio permite recuperar una frase partida por OCR. Por defecto se mantienen las preferencias de voz de cada fragmento. El compuesto se selecciona, numera y mueve como una unidad, pero conserva textos, UUID, formatos, geometria, referencias y parrafos SQL individuales. Un titulo compuesto produce un solo encabezado y una entrada de indice.

El inspector del contenido unido permite editar los fragmentos, lectura, estilo comun y separacion. Separar contenido funciona tambien tras guardar/recargar: recupera las ubicaciones y pesos originales si el grupo no se ha movido y los contenedores siguen disponibles. Si cambio la distribucion o un preset reemplazo los contenedores, separa en la posicion actual sin deshacer cambios posteriores. Deshacer/Rehacer actuan sobre la union antes de guardar. La fuente original nunca se modifica.

El contrato agrega `content` opcional a una columna de hojas directas: tipo, separador y ajustes comunes. `content.origins` conserva las posiciones historicas. Se mantiene la version 1 del documento y no se necesita una migracion de tablas. Las referencias a un antiguo titulo miembro se resuelven al ancla del titulo unido mientras exista esa union.

## Distribucion visual

Las filas contienen hijos en horizontal y las columnas en vertical. Se pueden combinar y anidar, ajustar pesos y separaciones, crear contenedores y desagruparlos. Los presets ofrecen una columna, dos columnas, 2 x 2 y una fila horizontal. El layout recibido sirve de distribucion inicial.

Arrastrar desde un asa hasta una zona mueve el bloque o grupo completo. Mover a... y Numero / orden son alternativas por teclado y para movil. La numeracion y narracion siguen el recorrido del arbol, terminando una columna antes de la siguiente. La numeracion editorial incluye los bloques anulados; sus IDs no dependen de ese numero.

Los contenedores de origen no son coordenadas absolutas del texto reconstruido. El texto fluye y las filas se apilan en pantallas estrechas para evitar solapamientos y desbordamientos. El ancho de presentacion de una imagen es independiente de su caja de origen.

## Crear y recuperar

Crear bloque sobre una imagen sin ajustes pendientes permite dibujar un rectangulo y elegir texto, titulo o imagen. Texto y titulo se introducen manualmente; una imagen puede recortarse de esa zona. El recorte local es temporal y el servidor genera el recurso al guardar, sin modificar los bytes de la fuente. Tambien se pueden reutilizar imagenes existentes o subir PNG/JPEG/WEBP pequenos; el cliente limita nuevas subidas a 1 MB codificado.

Mostrar anulados permite restaurar el mismo bloque. Los anulados desaparecen del resultado de lectura, TTS, busqueda, indice y exportaciones reconstruidas. Los originales descargables y los PDF de imagenes conservan los pixeles originales. Las anotaciones de un bloque anulado se conservan, pero sus destinos se ocultan del lector. Los textos IA anteriores quedan obsoletos y no se vuelven a narrar como respuestas actuales; la regeneracion es explicita, nunca automatica de pago.

## Margenes del OCR automatico

Al volver a reconocer una pagina de un libro existente, se buscan lineas cortas aisladas y con caja del margen superior que se repitan exactamente en al menos dos paginas distintas de la pagina objetivo. Ese contexto ayuda a clasificar cabeceras recurrentes aunque Textract las devuelva como titulos. No se hacen coincidencias aproximadas con el nombre del autor; se protegen palabras de capitulos y apariciones dentro del cuerpo. Si falta geometria o repeticion suficiente, se conserva la clasificacion del proveedor.

Textract y Vision pueden generar dos bloques independientes de pie y numero con el mismo identificador de fila cuando sus cajas son inferiores, no se solapan horizontalmente y tienen alturas compatibles. La representacion automatica centra el pie respecto a toda la pagina y situa el numero a la derecha, sin crear un tercer bloque de contenido. Los pesos manuales desactivan esa regla. No se reorganizan documentos visuales ya guardados ni se cambian correcciones manuales al cargar.

El OCR local no ofrece esa misma clasificacion geometrica. La mejora de cabeceras recurrentes aprovecha el historial de un libro al reprocesar; no supone que una foto aislada o un libro recien importado disponga de ese contexto.

## Origen PDF y EPUB

El inspector y la distribucion funcionan tambien sin imagen fuente. El panel izquierdo muestra Contenido importado, no un facsimil de la pagina PDF. Se guarda una instantanea HTML de origen en la primera conversion visual y se conservan las referencias de las imagenes inline y no asociadas a parrafos. Los nuevos bloques sin zona se seleccionan desde la previsualizacion.

La adaptacion utiliza los parrafos persistidos como identidades, no el numero de lineas de un textarea. Se mantiene el texto incluso si un documento heredado tiene distinto numero de parrafos SQL y nodos HTML. Las imagenes heredadas no narradas no se activan automaticamente para voz. Cargar la pagina no persiste ni reprocesa el libro.

## Contrato y limites

SQL037 agrega el documento visual JSON, la instantanea HTML de origen, actividad, inclusion en TOC, ancho de imagen y flags de obsolescencia de derivados. Su script es `apps/api/src/scripts/migrate-visual-page-editor.ts`; es aditivo e idempotente.

`GET /books/:bookId/pages/:pageNumber?includeInactive=true` requiere OWNER/EDITOR y devuelve el documento completo, derivado o persistido. El GET ordinario no expone el documento ni la instantanea de origen y excluye contenido anulado.

`PUT /books/:bookId/pages/:pageNumber/visual-document` recibe `{ document, expectedUpdatedAt }` y devuelve `{ document, updatedAt }`. Todos los parrafos existentes conservan su UUID; anular no los elimina. Los UUID nuevos son del cliente y se comprueba que no pertenezcan a otra pagina. El orden del arbol determina la numeracion SQL y los desplazamientos de secuencias. Recursos, contenido, metadatos y layout se guardan en una transaccion.

Limites: 500 bloques, 1000 nodos y profundidad 8; cada bloque aparece exactamente una vez. `sourceKey` vincula una imagen importada con su elemento de origen aunque cambie su recurso. No se almacenan URLs `blob:` ni previsualizaciones temporales de recortes.

Conflictos de version devuelven 409 y conservan el borrador. Guardar ajustes de la imagen y el documento encadena versiones. Tras guardar los bytes ajustados, se restablecen los controles de giro/recorte para no aplicarlos otra vez. Un fallo parcial se informa y bloquea reintentos hasta reconciliarlo. Ajustar la imagen invalida geometria, pero conserva tipos y flags.

## Verificacion

- `npm run typecheck`
- `npm test --workspace @lector/api`
- `npm test --workspace @lector/web`

Las pruebas de navegador usan proveedores y datos simulados. Las pruebas de Oracle se ejecutan bajo una transaccion de ensayo con rollback y verificacion posterior; no convierten libros de produccion.
