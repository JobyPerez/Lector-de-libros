# Runner self-hosted para despliegue de main

Este repositorio ya incluye el workflow [.github/workflows/deploy-main.yml](../.github/workflows/deploy-main.yml). Para que realmente despliegue en este servidor, GitHub Actions debe ejecutarse en un runner self-hosted instalado en la misma máquina donde existe la ruta /home/ubuntu/DEV-JPG/Lector-de-libros y donde corre PM2.

Comportamiento actual del workflow:

- Hace despliegue automático cuando hay push a main.
- Permite despliegue manual de cualquier rama usando workflow_dispatch y el input target_branch.
- Permite despliegue manual de un pull request usando el workflow Deploy Pull Request y el input pr_number.
- Si quieres despliegue automático de otra rama concreta, debes añadir esa rama explícitamente en la sección push.branches del workflow.

## Requisitos

- Instalar el runner con el mismo usuario de Linux que administra PM2 para este proyecto. En este servidor ese usuario debe ser ubuntu. Si el runner corre con otro usuario, pm2 restart conejolector-api no encontrará el proceso correcto.
- Tener disponibles git, node, npm y pm2 en el PATH del usuario ubuntu.
- Mantener una copia funcional del repositorio en /home/ubuntu/DEV-JPG/Lector-de-libros.

## Alta del runner en GitHub

1. En GitHub, entrar a Settings > Actions > Runners del repositorio JobyPerez/Lector-de-libros.
2. Pulsar New self-hosted runner.
3. Elegir Linux y la arquitectura real del servidor.
4. Copiar los comandos de descarga que muestra GitHub y ejecutarlos como usuario ubuntu dentro de una carpeta dedicada, por ejemplo /home/ubuntu/actions-runner.

Ejemplo de preparación de carpeta:

```bash
mkdir -p /home/ubuntu/actions-runner
cd /home/ubuntu/actions-runner
```

## Configuración recomendada

Cuando GitHub muestre el comando de configuración, conviene usar una variante como esta para dejar el runner identificado y sin prompts interactivos:

```bash
./config.sh \
  --url https://github.com/JobyPerez/Lector-de-libros \
  --token TU_TOKEN_TEMPORAL \
  --name conejolector-prod-01 \
  --labels conejolector-prod \
  --work _work \
  --unattended
```

Notas:

- El token lo genera GitHub en esa misma pantalla y expira rápido.
- La etiqueta conejolector-prod queda lista por si luego quieres restringir este workflow a un runner dedicado.
- El workflow actual sigue aceptando cualquier runner Linux self-hosted, así que no se rompe aunque todavía no uses la etiqueta dedicada.

## Instalar como servicio

Desde la carpeta del runner:

```bash
sudo ./svc.sh install ubuntu
sudo ./svc.sh start
```

Para revisar estado:

```bash
sudo ./svc.sh status
```

## Verificación

1. Confirmar en GitHub que el runner aparezca online.
2. Lanzar manualmente el workflow Deploy Branch desde Actions con workflow_dispatch.
3. Verificar que el job complete estos pasos: git pull, npm ci, npm run build y pm2 restart conejolector-api.
4. Si falla el reinicio de PM2, revisar primero con qué usuario quedó instalado el runner.

## Desplegar una rama concreta

Si quieres desplegar una rama concreta sin tocar el YAML, entra a Actions, abre el workflow Deploy Branch, pulsa Run workflow, deja Use workflow from en main y escribe la rama deseada en target_branch.

Esto evita depender de la lista de ramas que GitHub enseña en Use workflow from, que puede no mostrar algunas ramas de PR aunque existan en origin.

- GitHub lee el workflow estable desde main.
- El servidor despliega la rama indicada en target_branch.

Ejemplos válidos, siempre que la rama exista en origin:

```text
main
staging
release/abril-2026
feature/prueba-servidor
```

Limitación práctica:

- La rama indicada en target_branch debe existir en origin.
- Si la rama fue borrada del remoto, el workflow fallará en la validación previa al checkout.

## Desplegar un pull request concreto

Si quieres desplegar exactamente la rama head de un pull request abierto, entra a Actions, abre el workflow Deploy Pull Request, pulsa Run workflow, deja Use workflow from en main e indica el numero del PR en pr_number.

El workflow resolverá automáticamente estos datos desde GitHub:

- Numero del PR.
- Rama base del PR.
- Rama head del PR.
- Repositorio de la rama head.

Después validará y desplegará la rama head del PR en el servidor.

Limitaciones prácticas:

- El PR debe estar abierto.
- La rama head del PR debe existir en este mismo repositorio, no en un fork externo.
- Si la rama head fue borrada del remoto, el workflow fallará antes del checkout.

Si en cambio quieres despliegue automático al hacer push a una rama concreta, añade esa rama a push.branches:

```yaml
"on":
  push:
    branches:
      - main
      - staging
```

Después de eso, un push a staging también disparará el despliegue en el servidor.

## Ajuste opcional para usar etiqueta dedicada

Si quieres que este deploy solo corra en el runner de producción, cambia runs-on en el workflow a esta lista:

```yaml
runs-on:
  - self-hosted
  - linux
  - conejolector-prod
```

Haz ese cambio solo después de confirmar que el runner fue registrado con esa etiqueta.