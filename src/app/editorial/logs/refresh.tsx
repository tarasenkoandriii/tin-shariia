'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
export function LogRefresh(){const router=useRouter(),[auto,setAuto]=useState(false);useEffect(()=>{if(!auto)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')router.refresh();},15000);return()=>clearInterval(timer);},[auto,router]);return <div className="log-refresh"><button type="button" onClick={()=>router.refresh()}>Оновити журнал</button><label><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> Автооновлення кожні 15 с</label></div>;}
