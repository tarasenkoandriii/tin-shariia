export async function verifyCommentAfterReload(page,input){
  if(!/^[\w-]{11}$/.test(input.videoId)||!/^Ug[\w-]{10,100}$/.test(input.commentId)
    ||typeof input.expectedText!=='string'||input.expectedText.length>2000) return false;
  const url='https://www.youtube.com/watch?v='+input.videoId+'&lc='+input.commentId;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  // Verify a fresh response, rather than the optimistic local view after an edit.
  await page.reload({waitUntil:'domcontentloaded',timeout:30000});
  const comments=page.locator('ytd-comments#comments');
  await comments.waitFor({state:'attached',timeout:20000});
  await comments.scrollIntoViewIfNeeded();
  const permalink=page.locator('ytd-comment-thread-renderer').filter({
    has:page.locator('a[href*="lc='+input.commentId+'"]'),
  });
  try{
    await permalink.first().waitFor({state:'visible',timeout:20000});
    const found=await permalink.first().evaluate((element)=>{
      const renderer=element.querySelector('ytd-comment-renderer,ytd-comment-view-model');
      const content=element.querySelector('#content-text');
      const link=element.querySelector('#author-text');
      return {text:content?.textContent??'',author:link?.getAttribute('href'),
        channel:renderer?.data?.authorEndpoint?.browseEndpoint?.browseId??null};
    });
    const normalize=value=>value.replace(/\s+/g,' ').trim();
    return normalize(found.text)===normalize(input.expectedText)
      &&(!found.channel||found.channel===input.channelId);
  }catch{return false;}
}
