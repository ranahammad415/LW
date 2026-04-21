'use strict';
import('./src/index.js').catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
