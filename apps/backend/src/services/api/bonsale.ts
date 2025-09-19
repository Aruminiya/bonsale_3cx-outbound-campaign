import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';
import { 
  GetOutboundApiResult,
  PutCallStatusApiResult,
  PutBonsaleProjectAutoDialExecuteApiResult,
  PutDialUpdateApiResult,
  PostVisitRecordApiResult,
  GetBonsaleConfigApiResult,
  PutBonsaleConfigApiResult
} from '@/types/bonsale/index';

dotenv.config();

const host = process.env.BONSALE_HOST;
const xApiKey = process.env.BONSALE_X_API_KEY;
const xApiSecret = process.env.BONSALE_X_API_SECRET;

const axiosBonsaleInstance = axios.create({
  baseURL: host,
  headers: {
    'X-API-KEY': xApiKey,
    'X-API-SECRET': xApiSecret,
  },
});

async function getOutbound(
  callFlowId: string,
  projectId: string,
  callStatus: string,
  limit: number = 1
): Promise<GetOutboundApiResult> {
  try {
    const queryString = new URLSearchParams({
      callFlowIdOutbound: callFlowId,
      projectIdOutbound: projectId,
      callStatus,
      limit: String(limit)
    }).toString();
    const outboundResult = await axiosBonsaleInstance.get(`${host}/outbound?${queryString}`);
    const outboundProject = outboundResult.data;
    return { success: true, data: outboundProject }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getOutbound request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getOutbound request: ${axiosError.message}`
      }
    };
  }
}

async function updateCallStatus(
  projectId: string,
  customerId: string,
  callStatus: number
): Promise<PutCallStatusApiResult> {
  try {
    const response = await axiosBonsaleInstance.put(`${host}/project/${projectId}/customer/${customerId}/callStatus`, { callStatus });
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error updateCallStatus request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error updateCallStatus request: ${axiosError.message}`
      }
    };
  }
}

async function updateBonsaleProjectAutoDialExecute(
  projectId: string,
  callFlowId: string
): Promise<PutBonsaleProjectAutoDialExecuteApiResult> {
  try {
    const response = await axiosBonsaleInstance.put(`${host}/project/${projectId}/auto-dial/${callFlowId}/execute`, {});
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error updateBonsaleProjectAutoDialExecute request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error updateBonsaleProjectAutoDialExecute request: ${axiosError.message}`
      }
    };
  }
}

async function updateDialUpdate(
  projectId: string,
  customerId: string
): Promise<PutDialUpdateApiResult> {
  try {
    const response = await axiosBonsaleInstance.put(`${host}/project/${projectId}/customer/${customerId}/dialUpdate`, {});
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error updateDialUpdate request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error updateDialUpdate request: ${axiosError.message}`
      }
    };
  }
}

async function updateVisitRecord(
  projectId: string,
  customerId: string,
  visitType: string,
  visitedUsername: string,
  visitedAt: string,
  description: string,
  visitedResult: string,
): Promise<PostVisitRecordApiResult> {
  try {
    const payload = {
      projectId,
      customerId,
      visitType,
      visitedUsername,
      visitedAt,
      description,
      visitedResult,
    };
    const response = await axios.post(`${host}/project/customer/visit`, payload);
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error updateVisitRecord request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error updateVisitRecord request: ${axiosError.message}`
      }
    };
  }
}

async function getBonsaleConfig(
  configName: string
): Promise<GetBonsaleConfigApiResult> {
  try {
    const response = await axiosBonsaleInstance.get(`${host}/config/${configName}`);
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getBonsaleConfig request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getBonsaleConfig request: ${axiosError.message}`
      }
    };
  }
}

async function updateBonsaleConfig(
  configName: string,
  configData: unknown
): Promise<PutBonsaleConfigApiResult> {
  try {
    const response = await axiosBonsaleInstance.put(`${host}/config/${configName}`, {
      configName: configName,
      configValue: configData,
      description: '專案自動外播-執行專案暫存',
    });
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error updateBonsaleConfig request:', axiosError.message);
    return { 
      success: false, 
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error updateBonsaleConfig request: ${axiosError.message}`
      }
    };
  }
}

export {
  getOutbound,
  getBonsaleConfig,
  updateBonsaleConfig,
  updateCallStatus,
  updateBonsaleProjectAutoDialExecute,
  updateDialUpdate,
  updateVisitRecord
};