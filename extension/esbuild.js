const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info'
};

async function build() {
  if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log('watching extension for changes');
    return;
  }
  await esbuild.build(buildOptions);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
