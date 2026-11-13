import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { strFromU8, unzipSync } from 'fflate';
import { registerVideo, importTranscript } from '../src/db/editorial-import.mjs';
import { database } from '../src/db/runtime.mjs';
import { loadWorkflow } from '../src/db/editorial-workflow.mjs';
import { publicationPackage } from '../src/db/publications.mjs';
import { packageZip } from '../src/editorial/publication-zip.mjs';
import { editorialMutation } from '../src/http/editorial-workflow.mjs';

const origin='https://editorial.example.test';

test('editorial HTTP workflow enforces revisions, independent approvals and evidence snapshots', async () => {
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native ? await database() : new PGlite();
  try {
    if (!native) for (const filename of ['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0004_publication_records']) {
      await db.exec(await readFile(new URL('../drizzle/'+filename+'.sql',import.meta.url),'utf8'));
    }
    for (const [identity, roles] of [['writer',['author','factchecker','editor']],['checker',['factchecker']],['editor',['editor']],['publisher',['publisher']],['admin',['admin']]]) {
      const {rows:[{id}]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[identity,identity+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1, unnest($2::text[])',[id,roles]);
    }
    const video=await registerVideo(db,'https://youtu.be/QAtest00001');
    const other=await registerVideo(db,'https://youtu.be/QAtest00002');
    const transcript=await importTranscript(db,{videoId:video.id,format:'txt',bytes:Buffer.from('Original quote')});
    const foreign=await importTranscript(db,{videoId:other.id,format:'txt',bytes:Buffer.from('Unrelated')});
    async function send(collection, identity, payload, options={}) {
      const {id, review=false, method='POST', requestOrigin=origin}=options;
      const request=new Request(origin+'/api/'+collection,{method,headers:{origin:requestOrigin},body:JSON.stringify(payload)});
      const response=await editorialMutation(request,{db,identity,collection,id,review,origin});
      return [response.status,await response.json()];
    }
    const draft={
      action:'create',parentId:video.id,transcriptId:transcript.id,quote:'Original quote',question:'What happened?',
      verdict:'confirmed',explanation:'The source corroborates the claim.',startMs:1000,endMs:2000,
      evidence:[{title:'Report',url:'https://example.test/report',accessedOn:'2026-11-12',locator:'p. 4',coverage:'Chronology'}],
    };
    const change=(collection, identity, item, action, extra={})=>send(collection,identity,{
      ...extra,action,expectedRevision:item.revision,version:item.version,
    },{id:item.id,review:['return','approve'].includes(action),method:action==='edit'?'PATCH':'POST'});
    const take=([status,json])=>{assert.ok(status<300,JSON.stringify(json));return json.data;};
    async function fails(response,status,code){
      assert.deepEqual(await response,[status,{error:{code}}]);
    }
    await fails(send('claims',null,draft),401,'AUTH_REQUIRED');
    await fails(send('claims','publisher',draft),403,'FORBIDDEN');
    // Admin holds every role and may approve own work (single-person desk); others still need an independent reviewer.
    let own=take(await send('claims','admin',draft));
    own=take(await change('claims','admin',own,'submit'));
    own=take(await change('claims','admin',own,'approve'));
    assert.equal(own.status,'approved');
    await fails(send('claims','writer',draft,{requestOrigin:'https://other.example.test'}),403,'ORIGIN_DENIED');
    await fails(send('claims','writer',{...draft,transcriptId:foreign.id}),422,'TRANSCRIPT_MISMATCH');
    await fails(send('claims','writer',{...draft,evidence:[{...draft.evidence[0],url:'javascript:alert(1)'}]}),422,'INVALID_INPUT');
    let claim=take(await send('claims','writer',draft));
    const edits=await Promise.all([
      change('claims','writer',claim,'edit',draft),
      change('claims','writer',claim,'edit',draft),
    ]);
    assert.deepEqual(edits.map(([status])=>status).sort(),[200,409]);
    claim=take(edits.find(([status])=>status===200));
    claim=take(await change('claims','writer',claim,'submit'));
    await fails(change('claims','writer',claim,'approve'),403,'SELF_APPROVAL');
    await fails(change('claims','checker',claim,'return'),422,'INVALID_INPUT');
    claim=take(await change('claims','checker',claim,'return',{comment:'Уточніть висновок'}));
    claim=take(await change('claims','writer',claim,'submit'));
    claim=take(await change('claims','checker',claim,'approve'));
    const acceptedVersion=claim.version;
    const script={action:'create',parentId:claim.id,claimVersion:claim.version,title:'Episode',script:'Opening'};
    let episode=take(await send('episodes','writer',script));
    episode=take(await change('episodes','writer',episode,'submit'));
    await fails(change('episodes','writer',episode,'approve'),403,'SELF_APPROVAL');
    episode=take(await change('episodes','editor',episode,'approve'));

    claim=take(await change('claims','writer',claim,'edit',{...draft,evidence:[{...draft.evidence[0],title:'Updated report'}]}));
    const workspace=await loadWorkflow(db,'writer',video.id);
    assert.equal(workspace.episodes[0].stale,true);
    const {rows:[old]}=await db.query(
      'SELECT snapshot FROM claim_evidence WHERE claim_id=$1 AND claim_version=$2',[claim.id,acceptedVersion],
    );
    assert.equal(old.snapshot.title,'Report');
    await fails(change('episodes','writer',episode,'edit',script),409,'CLAIM_NOT_APPROVED');
    claim=take(await change('claims','writer',claim,'submit'));
    claim=take(await change('claims','checker',claim,'approve'));
    await fails(change('episodes','writer',episode,'edit',script),409,'CLAIM_STALE');
    episode=take(await change('episodes','writer',episode,'edit',{...script,claimVersion:claim.version}));
    episode=take(await change('episodes','writer',episode,'submit'));
    episode=take(await change('episodes','editor',episode,'approve'));
    const snapshot=await publicationPackage(db,'publisher',episode.id,episode.version);
    const archive=unzipSync(packageZip(snapshot));
    assert.equal(JSON.parse(strFromU8(archive['manifest.json'])).episodeVersion,episode.version);
    assert.equal(strFromU8(archive['script.txt']).trim(),snapshot.episode.script);
    assert.equal(JSON.parse(strFromU8(archive['sources.json'])).length,1);
    const done=await loadWorkflow(db,'writer',video.id);
    assert.equal(done.episodes[0].stale,false);
    assert.equal(done.episodes[0].version,2);
    assert.ok(done.events.some(e=>e.comment==='Уточніть висновок'));
    await db.query("UPDATE members SET revoked_at=now() WHERE clerk_user_id='editor'");
    await assert.rejects(loadWorkflow(db,'editor',video.id),/FORBIDDEN/);
  } finally { if (!native) await db.close(); }
});
