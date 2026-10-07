# Reconstruccion avanzada de pagina

La opcion `Reconstruccion avanzada de pagina` aparece en los selectores OCR
de crear, anadir y volver a reconocer paginas. Empieza desmarcada y no se
guarda como preferencia global. El OCR normal no ejecuta la segunda fase.

Al activarla, se realiza el OCR elegido y despues un analisis visual de la
imagen completa junto con el texto extraido. AWS combina Textract con el
modelo visual seleccionado; Vision realiza dos pasadas con el mismo modelo.
No esta disponible para LOCAL. El modo interno AUTO mantiene sus fallbacks
para la primera fase, pero no omite la segunda cuando se ha solicitado.

La segunda fase usa un prompt dedicado que exige un `layout` con contenido
inline: el servidor genera las identidades y referencias de los bloques,
sin pedir al modelo que sincronice dos listas. No reaplica las filas del OCR
base (ya aplicadas en la primera fase), porque contradicen el contrato del
arbol anidado. Si el modelo devuelve un bloque con `type: "pageNumber"`, se
convierte en parrafo con rol de numero de pagina sin narracion.

Esta opcion tarda mas y puede aumentar el coste. La imagen y su texto se
envian a los proveedores efectivos de ambas fases. No garantiza una copia
exacta del original ni mejora automaticamente las paginas ya guardadas.

## Resultado

La segunda fase propone bloques y un arbol anidado de filas y columnas.
Puede agrupar una imagen con su pie y reconstruir tablas sencillas mediante
filas y celdas, sin concatenar todas sus columnas como un unico parrafo.
Los colores, bordes y otros estilos se limitan a la lista segura del documento
visual; no se acepta HTML o CSS arbitrario del modelo.

El modelo recibe un catalogo de regiones de texto y recortes base con sus
coordenadas normalizadas. Cuando hay recortes de contenido, los selecciona
por referencia, sin volver a inventar sus coordenadas. Los iconos pequenos y
etiquetas rasterizadas se excluyen como ilustraciones; sus rotulos deben
transcribirse como texto. Se comprueba la cobertura de regiones de cuerpo
sustanciales para rechazar omisiones importantes.

Las regiones textuales completas y unicas recuperan la geometria base por
referencia o coincidencia fiable. Los textos divididos, como celdas de tabla,
conservan su geometria propia, sin asignarles la caja de toda la tabla.
Las filas nuevas se contrastan con esa geometria: se corrigen bandas
verticales inequivocas y se rechazan cruces ambiguos. Los anchos de imagen se
calculan sobre el arbol final; los pesos de columnas no fuerzan alturas.

Las tablas mantienen sus columnas en movil y disponen de desplazamiento
horizontal propio. El resto de zonas puede apilarse para adaptar la lectura.
No existe soporte especifico de rowspan/colspan en esta representacion.

El documento visual se persiste con los mismos IDs que sus parrafos SQL.
Al repetir OCR se conservan las identidades y flags cuando hay una
correspondencia fiable. Los parrafos anteriores no emparejados quedan
inactivos y siguen disponibles en el editor; no se borran sus anotaciones.
La maquetacion manual se reemplaza, previo aviso al usuario.

## Fallos y reintentos

Los errores de la segunda fase no producen un guardado silencioso del OCR
basico. Sus reintentos reutilizan el resultado de la primera fase en memoria,
con un limite de tres solicitudes visuales, incluidas las recuperaciones de
truncado o imagen rechazada. Al agotarse el limite, la operacion falla sin
reiniciar automaticamente todo el procesamiento.

Un nuevo intento manual inicia una operacion nueva y puede repetir costes.
La respuesta se valida antes de escribir: referencias completas y unicas,
jerarquia de tablas, estilos, numero de bloques, nodos y profundidad.
El rerun reserva espacio para los parrafos anteriores que deba conservar.

Cuando la respuesta no pasa la validacion, el reintento indica al modelo el
motivo exacto del rechazo (rutas y codigos, nunca el contenido), para que lo
corrija en lugar de intentarlo a ciegas. Si se agota el limite, el error
muestra la causa (por ejemplo, respuesta no valida del proveedor) y el numero
de intentos, sin repetir automaticamente el OCR base.

Para paginas densas se recomienda GPT-5.4 Mini o Gemini 3.5 Flash Lite: los
modelos mas pequenos pueden no seguir el contrato del arbol anidado.

## Comprobacion

Para evaluar un libro, activar la opcion solo en una pagina representativa,
seleccionar el modelo y comparar con el original antes de procesar un lote.
Revisar especialmente texto, columnas de tablas, pies, recortes y orden de
narracion. Los tests automatizados usan proveedores y persistencia simulados;
no sustituyen esta comparacion con la respuesta real del modelo.
