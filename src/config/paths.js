const path = require('path');

// Anchor storage and assets to the repository, independent of the launch cwd.
const root = path.resolve(__dirname, '../..');
module.exports = {
  root,
  dataDir: path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  researchDir: path.join(root, 'config/research'),
};
