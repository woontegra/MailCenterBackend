const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src', 'database');
const destDir = path.join(__dirname, 'dist', 'database');

// Create dist/database directory if it doesn't exist
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Copy all .sql files
const files = fs.readdirSync(srcDir);
files.forEach(file => {
  if (file.endsWith('.sql')) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    fs.copyFileSync(srcPath, destPath);
    console.log(`✓ Copied ${file}`);
  }
});

console.log('✓ All SQL files copied to dist/database/');
