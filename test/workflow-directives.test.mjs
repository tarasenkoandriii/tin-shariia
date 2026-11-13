import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import test from 'node:test';

// The workflow builder only registers steps whose directive sits alone on its line
// (@workflow/builders useStepPattern). A one-line `{'use step';…}` builds fine but fails at runtime
// with "Step … is not registered in the current deployment".
test('every workflow directive stands alone on its own line',async()=>{
  const dir=new URL('../src/workflows/',import.meta.url);
  for(const name of (await readdir(dir)).filter(file=>/\.(ts|mjs|js)$/.test(file))){
    const source=await readFile(new URL(name,dir),'utf8');
    for(const [index,line] of source.split('\n').entries()){
      if(!/(['"])use (step|workflow)\1/.test(line))continue;
      assert.match(line,/^\s*(['"])use (step|workflow)\1;?\s*$/,`${name}:${index+1} must put the directive on its own line`);
    }
  }
});
