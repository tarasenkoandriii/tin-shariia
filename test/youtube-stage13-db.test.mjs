import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {consumeOAuthState,createOAuthState,getYouTubeConnection,saveYouTubeConnection} from '../src/db/youtube-uploads.mjs';

const migrations=['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0003_analysis_queue',
  '0004_publication_records','0005_episode_media','0006_video_audits','0007_video_release_approval',
  '0008_shorts','0009_shorts_audit','0010_youtube_uploads'];

test('YouTube OAuth state is publisher-only, identity-bound and single-use; channel secrets never reach status view',async()=>{
  const db=new PGlite();
  try{
    for(const name of migrations)await db.exec(await readFile(new URL(`../drizzle/${name}.sql`,import.meta.url),'utf8'));
    for(const [identity,email,role] of [['publisher','publisher@example.test','publisher'],['author','author@example.test','author']]){
      const {rows:[member]}=await db.query('INSERT INTO members(clerk_user_id,email) VALUES($1,$2) RETURNING id',[identity,email]);
      await db.query('INSERT INTO member_roles(member_id,role) VALUES($1,$2)',[member.id,role]);
    }
    const stateHash='a'.repeat(64),codeVerifier='v'.repeat(43);
    await assert.rejects(createOAuthState(db,'author',{stateHash,codeVerifier}),/FORBIDDEN/);
    await createOAuthState(db,'publisher',{stateHash,codeVerifier});
    await assert.rejects(consumeOAuthState(db,'author',stateHash),/FORBIDDEN/);
    assert.deepEqual(await consumeOAuthState(db,'publisher',stateHash),{memberId:(await db.query("SELECT id FROM members WHERE clerk_user_id='publisher'")).rows[0].id,codeVerifier});
    await assert.rejects(consumeOAuthState(db,'publisher',stateHash),/YOUTUBE_OAUTH_STATE_INVALID/);
    await saveYouTubeConnection(db,'publisher',{channelId:'channel123',channelTitle:'Shariy',
      refreshTokenEncrypted:'v1.encrypted.payload',scopes:['youtube.upload','youtube.readonly']});
    const connection=await getYouTubeConnection(db,'publisher');
    assert.equal(connection.channel_id,'channel123');
    assert.equal(Object.hasOwn(connection,'refresh_token_encrypted'),false);
    await assert.rejects(getYouTubeConnection(db,'author'),/FORBIDDEN/);
  }finally{await db.close();}
});
