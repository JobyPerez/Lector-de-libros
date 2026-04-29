# Instrucciones del repositorio

Si en el fichero .env, la variable ENTORNO=servidor, entonces realiza los siguientes 3 puntos:

1. Después de cualquier cambio en este repositorio, ejecuta `npm run build` desde la raíz del workspace.
2. Cuando el build termine correctamente, ejecuta `pm2 restart conejolector-api`.
3. No des una tarea por terminada si alguno de esos pasos falla; informa el error al usuario.
