import { strToU8, zipSync } from 'fflate';

export function packageZip(snapshot){
  const {episode,sources}=snapshot;
  const files={
    'title.txt':episode.title,
    'description.txt':episode.description,
    'script.txt':episode.script,
    'thumbnail.txt':episode.thumbnail,
    'captions.txt':episode.captions,
    'pinned-comment.txt':episode.pinnedComment,
    'fragments.txt':episode.fragments,
    'sources.json':JSON.stringify(sources,null,2),
    'manifest.json':JSON.stringify(snapshot,null,2),
  };
  if(episode.subtitles) files['subtitles.txt']=episode.subtitles;
  const bytes=Object.fromEntries(Object.entries(files).map(([name,value])=>[name,strToU8(value+'\n')]));
  const limit=2*1024*1024;
  if(Object.values(bytes).reduce((sum,value)=>sum+value.length,0)>limit) throw Error('PACKAGE_TOO_LARGE');
  const archive=zipSync(bytes);
  if(archive.length>limit) throw Error('PACKAGE_TOO_LARGE');
  return archive;
}
