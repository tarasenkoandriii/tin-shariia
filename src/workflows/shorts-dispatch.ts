import {start} from 'workflow/api';
import {database} from '../db/runtime.mjs';
import {dispatchShorts} from '../media/shorts-queue.mjs';
import {renderShort} from './shorts-render';

export async function dispatchShortRenders(){
  return dispatchShorts(await database(),async(id:string,token:string)=>{await start(renderShort,[id,token]);});
}
