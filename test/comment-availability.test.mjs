import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCommentAvailability} from '../src/youtube/comment-availability.mjs';
test('only commentsDisabled confirms closed comments',()=>{
 assert.equal(classifyCommentAvailability(403,{error:{errors:[{reason:'commentsDisabled'}]}}).canComment,false);
 for(const reason of ['quotaExceeded','forbidden','insufficientPermissions'])assert.equal(classifyCommentAvailability(403,{error:{errors:[{reason}]}}).canComment,null);
 assert.equal(classifyCommentAvailability(200,{items:[]}).canComment,true);
});
