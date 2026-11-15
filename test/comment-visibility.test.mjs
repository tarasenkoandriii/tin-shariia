import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyCommentAfterReload,verifyCommentInIncognito} from '../services/youtube-reader/comment-visibility.mjs';
const input={videoId:'SVIDu_m8UT4',commentId:'UgwGdCbOnJpfpDD-NnJ4AaABAg',channelId:'ours',expectedText:'Перевірка\n\nhttps://is.gd/test'};
function mock(text=input.expectedText,channel='ours'){
 const events=[];
 const thread={filter(){return this;},first(){return this;},async waitFor(){events.push('visible');},async evaluate(){return {text,channel};}};
 const page={async goto(){events.push('goto');},async reload(){events.push('reload');},frames(){return [{getByText(){return {async count(){return 1;},first(){return {async click(){events.push('reject-cookies');}};}};}}];},async waitForTimeout(){},locator(selector){if(selector==='ytd-comments#comments')return {async waitFor(){},async scrollIntoViewIfNeeded(){events.push('scroll');}};return thread;},async screenshot(){events.push('screenshot');}};
 return {page,events};
}
test('checks after reload and dismisses consent in iframe before reading',async()=>{const {page,events}=mock();assert.equal(await verifyCommentAfterReload(page,input),true);assert.deepEqual(events,['goto','reload','reject-cookies','scroll','visible']);});
test('rejects wrong text, wrong author, malformed input and unavailable page',async()=>{
 assert.equal(await verifyCommentAfterReload(mock('different').page,input),false);
 assert.equal(await verifyCommentAfterReload(mock(input.expectedText,'other').page,input),false);
 assert.equal(await verifyCommentAfterReload(mock().page,{...input,videoId:'bad'}),false);
 const {page,events}=mock();page.goto=async()=>{throw Error('timeout');};assert.equal(await verifyCommentAfterReload(page,input),false);assert.ok(events.includes('screenshot'));
});

test('uses fresh incognito context and closes it even on failed verification',async()=>{
 const {page,events}=mock();
 const browser={async newContext(options){assert.deepEqual(options.storageState,{cookies:[],origins:[]});events.push('new-context');return {async newPage(){return page;},async close(){events.push('closed');}};}};
 assert.equal(await verifyCommentInIncognito(browser,input),true);
 assert.equal(events[0],'new-context');assert.equal(events.at(-1),'closed');
 page.goto=async()=>{throw Error('offline');};
 assert.equal(await verifyCommentInIncognito(browser,input),false);assert.equal(events.at(-1),'closed');
});
