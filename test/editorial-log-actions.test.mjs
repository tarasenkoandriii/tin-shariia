import {test} from 'node:test';
import assert from 'node:assert/strict';
import {logRecordType,nextLogAction} from '../src/editorial/log-actions.mjs';

const video='11111111-1111-4111-8111-111111111111';
const episode='22222222-2222-4222-8222-222222222222';
const comment='33333333-3333-4333-8333-333333333333';
const row=(fields)=>({linked_video_id:null,episode_id:null,level:'success',...fields});

test('comment and visibility snapshots open the exact comment',()=>{
 assert.deepEqual(nextLogAction(row({key:'comment:'+comment,process:'comments',state:'published',linked_video_id:video})),
  {label:'Відкрити коментар',href:'/editorial/youtube-comments#comment-'+comment});
 assert.deepEqual(nextLogAction(row({key:'visibility:'+comment,process:'comments',state:'verified'})),
  {label:'Відкрити коментар',href:'/editorial/youtube-comments#comment-'+comment});
 assert.equal(nextLogAction(row({key:'visibility:bad id<script>',process:'comments',state:'blocked',level:'error'})).href,
  '/editorial/youtube-comments#visibility','unsafe ids are never put into the link');
});

test('comment events carry an event id, so they link to the visibility list',()=>{
 assert.deepEqual(nextLogAction(row({key:'comment-event:'+comment,process:'comments',state:'approve'})),
  {label:'Відкрити коментарі',href:'/editorial/youtube-comments#visibility'});
});

test('short links go to the comments page',()=>{
 assert.deepEqual(nextLogAction(row({key:'link:'+comment,process:'links',state:'prepared'})),
  {label:'Відкрити коментарі',href:'/editorial/youtube-comments'});
});

test('failed or unknown captions offer a new import',()=>{
 for(const [state,level] of [['failed','error'],['unknown','warning']])
  assert.deepEqual(nextLogAction(row({key:'captions:'+video,process:'captions',state,level,linked_video_id:video})),
   {label:'Імпортувати субтитри знову',href:'/editorial/videos/'+video+'#transcripts'});
 assert.equal(nextLogAction(row({key:'captions:'+video,process:'captions',state:'failed'})),null,'no video, no link');
 assert.equal(nextLogAction(row({key:'captions:'+video,process:'captions',state:'done',linked_video_id:video})).label,'Відкрити картку');
});

test('gemini opens the analysis section',()=>{
 assert.deepEqual(nextLogAction(row({key:'gemini:1',process:'gemini',state:'failed',level:'error',linked_video_id:video})),
  {label:'Перевірити аналіз',href:'/editorial/videos/'+video+'#analysis'});
 assert.equal(nextLogAction(row({key:'gemini:1',process:'gemini',state:'succeeded',linked_video_id:video})).href,'/editorial/videos/'+video+'#analysis');
});

test('episode processes open the matching episode stage on the video card',()=>{
 const base={linked_video_id:video,episode_id:episode};
 assert.deepEqual(nextLogAction(row({...base,key:'grok:1',process:'grok',state:'failed',level:'error'})),
  {label:'Перевірити рецензію Grok',href:`/editorial/videos/${video}#episode-${episode}-grok`});
 assert.equal(nextLogAction(row({...base,key:'render:1',process:'render',state:'rendering',level:'active'})).href,`/editorial/videos/${video}#episode-${episode}-shorts`);
 assert.equal(nextLogAction(row({...base,key:'media:1',process:'render',state:'failed',level:'error'})).label,'Перевірити монтаж');
 assert.equal(nextLogAction(row({...base,key:'media:1',process:'render',state:'passed'})).href,`/editorial/videos/${video}#episode-${episode}-montage`);
 assert.deepEqual(nextLogAction(row({...base,key:'upload-event:1',process:'upload',state:'published'})),
  {label:'Відкрити картку',href:`/editorial/videos/${video}#episode-${episode}-publication`});
 assert.equal(nextLogAction(row({...base,key:'editorial:1',process:'editorial',state:'return',level:'warning'})).href,`/editorial/videos/${video}#episode-${episode}`);
 assert.deepEqual(nextLogAction(row({key:'editorial:2',process:'editorial',state:'approve',linked_video_id:video})),
  {label:'Відкрити картку',href:'/editorial/videos/'+video+'#claims'});
 assert.equal(nextLogAction(row({key:'grok:1',process:'grok',state:'accepted',linked_video_id:video})).href,'/editorial/videos/'+video,'without an episode the card itself');
});

test('success rows without a linked video have no action',()=>{
 assert.equal(nextLogAction(row({key:'upload:1',process:'upload',state:'published'})),null);
 assert.equal(nextLogAction(row({key:'editorial:1',process:'editorial',state:'create'})),null);
 assert.equal(nextLogAction(null),null);
});

test('record types distinguish a published comment from its visibility check',()=>{
 assert.equal(logRecordType('comment:'+comment),'Стан коментаря');
 assert.equal(logRecordType('visibility:'+comment),'Перевірка видимості');
 assert.equal(logRecordType('comment-event:1'),'Дія з коментарем');
 assert.equal(logRecordType('upload-event:1'),'Дія публікації');
 assert.equal(logRecordType('nothing'),null);
});
