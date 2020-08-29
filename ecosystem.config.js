module.exports = {
  apps: [{
    name: 'ETC-CLIENT',
    script: 'main.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    log_date_format: 'YYYY-MM-DDTHH:mm:ssZ',
    node_args: '-r dotenv/config -r esm',
    args: '--color'
  }]
};
