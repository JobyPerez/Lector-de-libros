module.exports = {
  apps: [
    {
      name: "conejolector-api",
      script: "apps/api/dist/server.js",
      cwd: "/home/ubuntu/DEV-JPG/Lector-de-libros",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};