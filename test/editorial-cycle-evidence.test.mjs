import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCaseEvidence} from '../src/automation/verified-case.mjs';
import {cycleSeedSchema} from '../src/automation/cycle-input.mjs';

test('evidence must exist in the fetched document; an invented model excerpt cannot approve a case',async()=>{
 const seed={factcheck:{quote:'q'},evidence:[{url:'https://szru.gov.ua/about/bio',excerpt:'Народився в Узбекистані.'},{url:'https://www.radiosvoboda.org/a/interview',excerpt:'Місце народження — Сочі.'}]};
 const fetchImpl=async url=>new Response(String(url).includes('szru')?'<p>Народився в Узбекистані.</p>':'<div>Місце народження — Сочі.</div>');
 const result=await verifyCaseEvidence(seed,{fetchImpl});assert.equal(result.confirmed,true);
 assert.equal(result.evidence[0].primary,true);assert.match(result.evidence[0].documentHash,/^[a-f0-9]{64}$/);
 await assert.rejects(verifyCaseEvidence({...seed,evidence:[{...seed.evidence[0],excerpt:'Народився у вигаданому місті.'},seed.evidence[1]]},{fetchImpl}),/QUOTE_MISMATCH/);
});
test('source retrieval rejects private/unapproved hosts, credentials and redirects',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return new Response('text');};
 for(const url of ['http://szru.gov.ua/x','https://127.0.0.1/x','https://user:pass@szru.gov.ua/x','https://szru.gov.ua:8443/x','https://szru.gov.ua.attacker.test/x']){
  await assert.rejects(verifyCaseEvidence({evidence:[{url,excerpt:'original document'},{url:'https://szru.gov.ua/x',excerpt:'original document'}]},{fetchImpl}),/SOURCE_INVALID/);
 }
 assert.equal(calls,0);
 let redirectMode;
 await assert.rejects(verifyCaseEvidence({evidence:[{url:'https://szru.gov.ua/x',excerpt:'original document'},{url:'https://szru.gov.ua/y',excerpt:'original document'}]},
 {fetchImpl:async(_url,options)=>{redirectMode=options.redirect;throw Error('redirect denied');}}),/redirect denied/);
 assert.equal(redirectMode,'error');
});
test('case schema does not accept arbitrary paths or executable plan properties',()=>{
 assert.equal(cycleSeedSchema.safeParse({editorVerified:true,manifest:{assets:[{path:'/etc/passwd'}]}}).success,false);
});
