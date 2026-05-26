# Instrucciones del repositorio

Antes de decidir cualquier paso de despliegue o reinicio, lee el fichero `.env` de la raíz y aplica esta matriz:

## `ENTORNO=local`

1. No uses PM2.
2. Ignora la variable `DESPLIEGUE`.
3. Para levantar la aplicación en caliente usa `npm run dev:all` desde la raíz del workspace. Esto arranca la API con `nodemon` y el cliente con Vite.
4. No ejecutes `npm run build:client` ni `pm2 restart conejolector-api` como parte normal de un cambio local.

## `ENTORNO=servidor` y `DESPLIEGUE=produccion`

1. Si el cambio afecta al frontend en `client/src` o a cualquier recurso que requiera regenerar `client/dist`, ejecuta primero `npm run build:client` desde la raíz del workspace.
2. Después de cualquier cambio en este repositorio, ejecuta `pm2 restart conejolector-api` desde la raíz del workspace. Este comando solo reinicia los procesos existentes; no ejecuta build, install ni pull.
4. No des una tarea por terminada si alguno de esos pasos falla; informa el error al usuario.

## `ENTORNO=servidor` y `DESPLIEGUE=desarrollo`

1. Usa PM2 para mantener vivos `conejolector-api`.
2. La ejecución debe ser en caliente: la API con `nodemon` y el cliente con Vite.
3. No ejecutes `npm run build:client` como parte normal de un cambio de frontend.
5. No des una tarea por terminada si alguno de esos pasos falla; informa el error al usuario.