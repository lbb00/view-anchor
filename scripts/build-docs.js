// Bundle the view-anchor core (src/view-anchor.ts) and inline it into the
// standalone 3D demo (docs/index.html) between the marker comments.
//
// Why inline rather than `import './core.js'`: the demo is meant to open by
// double-click (file://), where browsers block ES-module imports as cross-origin
// (origin "null"). Inlining keeps the page self-contained while still using the
// real built artifact — the block below is GENERATED from src, never hand-edited.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const htmlPath = resolve(root, 'docs/index.html')

const START =
  '/* __VIEW_ANCHOR_CORE_START__ — generated from src/view-anchor.ts by `pnpm build:docs`; do not edit */'
const END = '/* __VIEW_ANCHOR_CORE_END__ */'

const bundle = await rolldown({
  input: resolve(root, 'src/view-anchor.ts'),
  transform: { target: 'es2020' },
})
let code
try {
  const { output } = await bundle.generate({
    format: 'iife',
    name: '__viewAnchorCore',
  })
  code = output[0].code.trim()
} finally {
  await bundle.close()
}

const html = readFileSync(htmlPath, 'utf8')
const i = html.indexOf(START)
const j = html.indexOf(END)
if (i === -1 || j === -1 || j < i) {
  throw new Error('docs/index.html is missing the __VIEW_ANCHOR_CORE_{START,END}__ markers')
}
const next = html.slice(0, i) + START + '\n' + code + '\n' + END + html.slice(j + END.length)
writeFileSync(htmlPath, next)
console.log('inlined view-anchor core (%d bytes) into docs/index.html', code.length)
