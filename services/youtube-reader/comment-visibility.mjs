export async function verifyCommentAfterReload(page,input){
  if(!/^[\w-]{11}$/.test(input.videoId)||!/^Ug[\w-]{10,100}$/.test(input.commentId)
    ||typeof input.expectedText!=='string'||input.expectedText.length>2000) return false;
  const url='https://www.youtube.com/watch?v='+input.videoId+'&lc='+input.commentId;
  try {
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  // Verify a fresh response, rather than the optimistic local view after an edit.
  await page.reload({waitUntil:'domcontentloaded',timeout:30000});
  for(const frame of page.frames()){
    const rejectCookies=frame.getByText(/^(Alle ablehnen|Reject all|Відхилити всі|Отклонить все)$/);
    if(await rejectCookies.count())await rejectCookies.first().click({timeout:10000,force:true}).catch(()=>console.info('COMMENT_CONSENT_CLICK_FAILED'));
  }
  await page.waitForTimeout(1500);
  const comments=page.locator('ytd-comments#comments');
  await comments.waitFor({state:'attached',timeout:20000});
  await comments.scrollIntoViewIfNeeded();
  const permalink=page.locator('ytd-comment-thread-renderer').filter({
    has:page.locator('a[href*="lc='+input.commentId+'"]'),
  });
    await permalink.first().waitFor({state:'visible',timeout:20000});
    const found=await permalink.first().evaluate((element)=>{
      const renderer=element.querySelector('ytd-comment-renderer,ytd-comment-view-model');
      const content=element.querySelector('#content-text');
      const link=element.querySelector('#author-text');
      return {text:content?.textContent??'',author:link?.getAttribute('href'),
        channel:renderer?.data?.authorEndpoint?.browseEndpoint?.browseId??null};
    });
    const normalize=value=>value.replace(/\s+/g,' ').trim();
    const textMatches=normalize(found.text)===normalize(input.expectedText),authorMatches=found.channel===input.channelId;
    console.info('COMMENT_VERIFY_DIAGNOSTIC',{commentId:input.commentId,textMatches,authorMatches,textLength:found.text.length,expectedLength:input.expectedText.length});
    return textMatches&&authorMatches;
  }catch(error){
    console.info('COMMENT_VERIFY_DIAGNOSTIC',{commentId:input.commentId,reason:'PAGE_OR_COMMENT_UNAVAILABLE',type:error.name,step:String(error.message).split('\n')[0].slice(0,180)});
    await page.screenshot({path:'/tmp/comment-read-debug.png'}).catch(()=>{});
    return false;
  }
}

// A new non-persistent context has no publishing account cookies or local storage.
export async function verifyCommentInIncognito(browser,input){
  const context=await browser.newContext({storageState:{cookies:[],origins:[]},viewport:{width:1280,height:800}});
  try{return await verifyCommentAfterReload(await context.newPage(),input);}
  finally{await context.close();}
}
