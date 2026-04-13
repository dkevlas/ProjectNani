const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configura la ubicación de la caché para que Puppeteer guarde Chrome dentro de la carpeta del proyecto en Render.
    cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
