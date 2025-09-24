import getRawBody from "raw-body";
export function createRawBodyMiddleware(){return async function rawBody(req,res,next){try{req.rawBody=await getRawBody(req);next();}catch(e){next(e);}}}
