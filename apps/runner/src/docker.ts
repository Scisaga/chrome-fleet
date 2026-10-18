import { request } from 'node:http';
import { RunnerError } from './policy.js';

export class Docker {
  constructor(private socketPath=process.env.DOCKER_SOCKET??'/var/run/docker.sock'){}
  async call<T=any>(method:string,path:string,body?:unknown,timeout=120000):Promise<T> {
    return new Promise((resolve,reject)=>{
      let settled=false;
      const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);reject(new RunnerError('DOCKER_UNAVAILABLE','无法连接 Docker Engine',503));};
      const data=body===undefined?undefined:JSON.stringify(body);
      const req=request({socketPath:this.socketPath,path:`/v1.45${path}`,method,headers:data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}},res=>{
        const chunks:Buffer[]=[];let size=0;
        res.on('error',fail);res.on('aborted',fail);
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16*1024*1024){req.destroy();if(!settled){settled=true;clearTimeout(timer);reject(new RunnerError('DOCKER_RESPONSE_TOO_LARGE','Docker 返回数据超出限制',502));}}else chunks.push(chunk);});
        res.on('end',()=>{
          if(settled)return;settled=true;clearTimeout(timer);
          const raw=Buffer.concat(chunks).toString();let parsed:any;try{parsed=raw?JSON.parse(raw):{};}catch{parsed={};}
          if((res.statusCode??500)>=400){const code=res.statusCode===404?'DOCKER_NOT_FOUND':res.statusCode===409?'DOCKER_CONFLICT':'DOCKER_FAILED';reject(new RunnerError(code,'Docker 操作失败，请查看 Runner 诊断信息',res.statusCode===404?404:502));return;}
          resolve(parsed as T);
        });
      });
      const timer=setTimeout(()=>{req.destroy();fail();},timeout);
      req.on('error',fail);
      if(data)req.write(data);req.end();
    });
  }
}
