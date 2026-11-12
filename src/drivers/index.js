const cfg = require('../config');
function createDriver(name = cfg.driver) {
  if (name === 'asterisk') return require('./asterisk').createAsteriskDriver();
  return require('./simulator').createSimulator();
}
module.exports = { createDriver };
