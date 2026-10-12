// Record system-tool results separately from the isolated bootstrap runtime:
// node test/utility-reference-cases.mjs OUTPUT.json
// BUNMSH_UTILITY_REFERENCE=/guest/OUTPUT.json bun test test/utility-reference.test.js
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const diff = (name, before, after, args=[]) => ({name, tool:'diff', files:{before,after}, args:[...args,'before','after']});
const sed = (name, script, input, args=[]) => ({name, tool:'sed', files:{script}, args:[...args,'-f','script'], input});
export const cases = [
  diff('identical','a\nb\n','a\nb\n'),
  diff('middle insertion','a\nb\nc\n','a\nx\nb\nc\n'),
  diff('separated insertions','a\nb\nc\nd\n','a\nx\nb\nc\ny\nd\n'),
  diff('separated deletions','a\nx\nb\nc\ny\nd\n','a\nb\nc\nd\n'),
  diff('insertion then replacement','a\nb\nc\nd\ne\n','a\nx\nb\nc\nD\ne\n'),
  diff('repeated lines','a\nsame\nsame\nz\n','a\nsame\nnew\nsame\nz\n'),
  diff('empty left','','added\n'), diff('empty right','deleted\n',''),
  diff('missing final newline','a\n','a'), diff('both missing final newline','old','new'),
  diff('Chinese','前\n後\n','前\n中\n後\n'),
  diff('CRLF','a\r\nb\r\n','a\r\nx\r\nb\r\n'),
  diff('brief difference','a\n','b\n',['-q']),
  sed('file script and branch','s/a/b/\nt done\n:done\np\n','a\n',['-n']),
  sed('address range','2,3p\n','one\ntwo\nthree\nfour\n',['-n']),
  sed('inverted address','/skip/!p\n','keep\nskip\nkeep again\n',['-n']),
  sed('hold exchange','1h\n2{x;p;}\n','first\nsecond\n',['-n']),
  sed('hold append','1h\n2{H;g;p;}\n','first\nsecond\n',['-n']),
  sed('multiline N','N;s/\n/:/;p\n'.replace('s/\n','s/\\n'),'first\nsecond\n',['-n']),
  sed('branch loop',':again\ns/aa/a/\nt again\np\n','aaaa\n',['-n']),
  sed('translation','y/abc/ABC/\n','abc cab\n'),
  sed('escaped delimiter','s|a\\|b|X|g\n','a|b a|b\n'),
  sed('backreference','s/\\(ab\\)/[\\1]/g\n','abab\n'),
  sed('missing input newline','s/a/b/\n','a'),
  {name:'attached -f',tool:'sed',files:{script:'s/a/b/\n'},args:['-fscript'],input:'a\n'},
];
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Output JSON path required');
  const cwd=mkdtempSync(join(tmpdir(),'bunmsh-system-reference-'));
  try {
    const results=cases.map(c => {
      for (const [name,content] of Object.entries(c.files)) {
        mkdirSync(dirname(join(cwd,name)),{recursive:true});writeFileSync(join(cwd,name),content);
      }
      const r=spawnSync(`/usr/bin/${c.tool}`,c.args,{cwd,input:c.input??'',encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
      if (r.error || r.signal || r.status===null) throw r.error??new Error(`Reference failed: ${c.name}`);
      return {...c,expected:{status:r.status,stdout:r.stdout,stderr:r.stderr}};
    });
    const versions=Object.fromEntries(['diff','sed'].map(tool=>[tool,spawnSync(`/usr/bin/${tool}`,['--version'],{encoding:'utf8'}).stdout.split('\n')[0]]));
    writeFileSync(process.argv[2],JSON.stringify({versions,cases:results},null,2)+'\n');
    console.log(JSON.stringify({versions,cases:results.length}));
  } finally {rmSync(cwd,{recursive:true,force:true});}
}
