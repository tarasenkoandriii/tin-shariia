import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decryptYouTubeSecret,encryptYouTubeSecret,createYouTubeAuthorization,YOUTUBE_SCOPES} from '../src/youtube/oauth.mjs';
import {googleSessionUrl,youtubeOffsetFromRange,youtubeProcessingOutcome} from '../src/youtube/upload.mjs';

const tokenKey=Buffer.alloc(32,7).toString('base64url');

test('YouTube OAuth state is random, PKCE-bound, and restricted to upload plus read-only scopes',()=>{
  const a=createYouTubeAuthorization({memberId:'member-a',origin:'https://tin-shariia.viral4creators.app',clientId:'client-id'});
  const b=createYouTubeAuthorization({memberId:'member-a',origin:'https://tin-shariia.viral4creators.app',clientId:'client-id'});
  const url=new URL(a.authorizationUrl);
  assert.notEqual(a.state,b.state);
  assert.equal(a.stateHash.length,64);
  assert.equal(url.searchParams.get('state'),a.state);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(a.codeVerifier).digest('base64url'));
  assert.deepEqual(url.searchParams.get('scope').split(' '),YOUTUBE_SCOPES);
  assert.equal(url.searchParams.get('access_type'),'offline');
  assert.equal(url.searchParams.get('redirect_uri'),'https://tin-shariia.viral4creators.app/api/youtube/oauth/callback');
});

test('YouTube refresh tokens encrypt at rest and reject tampering or invalid keys',()=>{
  const envelope=encryptYouTubeSecret('refresh-token-value',{YOUTUBE_TOKEN_ENCRYPTION_KEY:tokenKey});
  assert.equal(decryptYouTubeSecret(envelope,{YOUTUBE_TOKEN_ENCRYPTION_KEY:tokenKey}),'refresh-token-value');
  const parts=envelope.split('.');parts[3]=Buffer.from('tampered').toString('base64url');
  assert.throws(()=>decryptYouTubeSecret(parts.join('.'),{YOUTUBE_TOKEN_ENCRYPTION_KEY:tokenKey}),/YOUTUBE_TOKEN_INVALID/);
  assert.throws(()=>encryptYouTubeSecret('secret',{YOUTUBE_TOKEN_ENCRYPTION_KEY:'short'}),/YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED/);
});

test('resumable YouTube session URLs cannot redirect uploads outside Google APIs',()=>{
  assert.equal(new URL(googleSessionUrl('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x')).hostname,'www.googleapis.com');
  assert.throws(()=>googleSessionUrl('http://www.googleapis.com/upload'),/YOUTUBE_SESSION_INVALID/);
  assert.throws(()=>googleSessionUrl('https://googleapis.com.attacker.invalid/upload'),/YOUTUBE_SESSION_INVALID/);
});

test('resumable uploads recover accepted byte ranges without blind restart',()=>{
  assert.equal(youtubeOffsetFromRange('bytes=0-8388607',16_000_000),8_388_608);
  assert.equal(youtubeOffsetFromRange(null,16_000_000),0);
  assert.throws(()=>youtubeOffsetFromRange('bytes=2-7',16_000_000),/YOUTUBE_SESSION_INVALID/);
  assert.throws(()=>youtubeOffsetFromRange('bytes=0-16000000',16_000_000),/YOUTUBE_SESSION_INVALID/);
});

test('upload reconciliation verifies both processing and the selected privacy status',()=>{
  assert.deepEqual(youtubeProcessingOutcome({id:'abcdefghijk',status:{uploadStatus:'processed',privacyStatus:'private'}},'private'),
    {state:'published',done:true,status:'processed',privacy:'private',errorCode:null});
  assert.equal(youtubeProcessingOutcome({id:'abcdefghijk',status:{uploadStatus:'processed',privacyStatus:'public'}},'private').errorCode,
    'YOUTUBE_PRIVACY_MISMATCH');
  assert.equal(youtubeProcessingOutcome({id:'abcdefghijk',status:{uploadStatus:'uploaded',privacyStatus:'private'}},'private').done,false);
});
