import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];
export const YOUTUBE_COMMENT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const b64url = value => Buffer.from(value).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest();

export function youtubeOAuthConfig(env=process.env) {
  const clientId=env.GOOGLE_YOUTUBE_CLIENT_ID;
  const clientSecret=env.GOOGLE_YOUTUBE_CLIENT_SECRET;
  const origin=env.APP_ORIGIN;
  if(!clientId||!clientSecret||!origin) throw Error('YOUTUBE_OAUTH_NOT_CONFIGURED');
  let app;
  try { app=new URL(origin); } catch { throw Error('YOUTUBE_OAUTH_NOT_CONFIGURED'); }
  if(app.protocol!=='https:'||app.origin!==origin) throw Error('YOUTUBE_OAUTH_NOT_CONFIGURED');
  return {clientId,clientSecret,origin,redirectUri:new URL('/api/youtube/oauth/callback',origin).toString()};
}

function encryptionKey(env=process.env) {
  const encoded=env.YOUTUBE_TOKEN_ENCRYPTION_KEY;
  if(typeof encoded!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw Error('YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED');
  const key=Buffer.from(encoded,'base64url');
  if(key.length!==32) throw Error('YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED');
  return key;
}

export function encryptYouTubeSecret(value,env=process.env) {
  if(typeof value!=='string'||!value) throw Error('YOUTUBE_TOKEN_INVALID');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(env),iv);
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['v1',b64url(iv),b64url(cipher.getAuthTag()),b64url(ciphertext)].join('.');
}

export function decryptYouTubeSecret(envelope,env=process.env) {
  if(typeof envelope!=='string') throw Error('YOUTUBE_TOKEN_INVALID');
  const [version,iv,tag,ciphertext,...extra]=envelope.split('.');
  if(version!=='v1'||!iv||!tag||!ciphertext||extra.length) throw Error('YOUTUBE_TOKEN_INVALID');
  try {
    const decipher=createDecipheriv('aes-256-gcm',encryptionKey(env),Buffer.from(iv,'base64url'));
    decipher.setAuthTag(Buffer.from(tag,'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64url')),decipher.final()]).toString('utf8');
  } catch { throw Error('YOUTUBE_TOKEN_INVALID'); }
}

export function createYouTubeAuthorization({memberId,origin,clientId,includeCommentScope=false}) {
  if(typeof memberId!=='string'||!memberId||typeof origin!=='string'||typeof clientId!=='string'||!clientId) throw Error('INVALID_INPUT');
  const state=b64url(randomBytes(32));
  const codeVerifier=b64url(randomBytes(32));
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',clientId);
  url.searchParams.set('redirect_uri',new URL('/api/youtube/oauth/callback',origin).toString());
  url.searchParams.set('response_type','code');
  url.searchParams.set('access_type','offline');
  url.searchParams.set('prompt','consent');
  url.searchParams.set('include_granted_scopes','true');
  url.searchParams.set('scope',[...YOUTUBE_SCOPES,...(includeCommentScope?[YOUTUBE_COMMENT_SCOPE]:[])].join(' '));
  url.searchParams.set('state',state);
  url.searchParams.set('code_challenge',b64url(sha256(codeVerifier)));
  url.searchParams.set('code_challenge_method','S256');
  return {state,stateHash:sha256(state).toString('hex'),codeVerifier,authorizationUrl:url.toString(),requestCommentScope:includeCommentScope===true};
}

async function providerJson(response) {
  const body=await response.json().catch(()=>null);
  if(!response.ok||!body||typeof body!=='object') throw Error('YOUTUBE_PROVIDER_ERROR');
  return body;
}

export async function exchangeYouTubeCode({code,codeVerifier,config,requiredScopes=YOUTUBE_SCOPES,fetchImpl=fetch}) {
  const response=await fetchImpl('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({code,code_verifier:codeVerifier,client_id:config.clientId,
      client_secret:config.clientSecret,redirect_uri:config.redirectUri,grant_type:'authorization_code'}),
    cache:'no-store',
  });
  const body=await providerJson(response);
  if(typeof body.access_token!=='string'||typeof body.refresh_token!=='string'
    ||typeof body.scope!=='string'||!Number.isFinite(body.expires_in)) throw Error('YOUTUBE_OAUTH_INCOMPLETE');
  const scopes=body.scope.split(/\s+/).filter(Boolean);
  if(!requiredScopes.every(scope=>scopes.includes(scope))) throw Error('YOUTUBE_SCOPE_REQUIRED');
  return {accessToken:body.access_token,refreshToken:body.refresh_token,scopes};
}

export async function fetchYouTubeChannel(accessToken,fetchImpl=fetch) {
  const url=new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part','snippet');url.searchParams.set('mine','true');
  const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${accessToken}`},cache:'no-store'});
  const body=await providerJson(response);
  const channel=body.items?.[0];
  if(typeof channel?.id!=='string'||typeof channel?.snippet?.title!=='string') throw Error('YOUTUBE_CHANNEL_NOT_FOUND');
  return {channelId:channel.id,title:channel.snippet.title};
}

export async function refreshYouTubeAccessToken(refreshToken,config,fetchImpl=fetch) {
  const response=await fetchImpl('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({refresh_token:refreshToken,client_id:config.clientId,
      client_secret:config.clientSecret,grant_type:'refresh_token'}),cache:'no-store',
  });
  const body=await providerJson(response);
  if(typeof body.access_token!=='string'||!Number.isFinite(body.expires_in)) throw Error('YOUTUBE_TOKEN_REFRESH_FAILED');
  return body.access_token;
}

export async function revokeYouTubeToken(token,fetchImpl=fetch) {
  const response=await fetchImpl('https://oauth2.googleapis.com/revoke',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({token}),cache:'no-store',
  });
  if(!response.ok) throw Error('YOUTUBE_REVOKE_FAILED');
}

