import GetOutbound from "./getOutbound";
import PutCallStatus from "./putCallStatus"
import PutBonsaleProjectAutoDialExecute from "./putBonsaleProjectAutoDialExecute";
import PutDialUpdate from "./putDialUpdate";
import PostVisitRecord from "./postVisitRecord";
import GetBonsaleConfig from "./getBonsaleConfig";
import PutBonsaleConfig from "./putBonsaleConfig"

export interface ApiResponse<T> {
  success: true;
  data: T;
}

export interface ApiError<E> {
  success: false;
  error: E;
}

export type ApiResult<T, E = { errorCode: string; error: string }> = ApiResponse<T> | ApiError<E>;

export type GetOutboundApiResult = ApiResult<GetOutbound>;
export type PutCallStatusApiResult = ApiResult<PutCallStatus>;
export type PutBonsaleProjectAutoDialExecuteApiResult = ApiResult<PutBonsaleProjectAutoDialExecute>;
export type PutDialUpdateApiResult = ApiResult<PutDialUpdate>;
export type PostVisitRecordApiResult = ApiResult<PostVisitRecord>;
export type GetBonsaleConfigApiResult = ApiResult<GetBonsaleConfig>;
export type PutBonsaleConfigApiResult = ApiResult<PutBonsaleConfig>;
