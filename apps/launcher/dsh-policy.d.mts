export function versionParts(value:unknown):{core:number[];pre?:string[]};
export function compareVersions(a:string,b:string):number;
export function installedVersion(entry:string):Promise<string|undefined>;
export function selectedEntry(paths:any,env:any,privateJson:(path:string)=>Promise<any>):Promise<string>;
export function resolveLatest(env:any):Promise<string>;
export function smokeDsh(entry:string,root:string,probe:(url:string)=>Promise<any>):Promise<void>;
export function stageAndActivate(options:{paths:any;version:string;root:string;env:any;runChild:(...args:any[])=>Promise<number>;probe:(url:string)=>Promise<any>;smoke?:(...args:any[])=>Promise<void>}):Promise<string>;
