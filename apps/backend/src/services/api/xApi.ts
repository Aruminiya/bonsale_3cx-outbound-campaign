import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const host = process.env.HTTP_HOST_3CX;

if (!host) {
  throw new Error('環境變數 HTTP_HOST_3CX 未定義，請檢查 .env 文件');
}

// 查詢當前活躍呼叫的列表
export async function activeCalls(token: string) {
  try {
    const response = await axios.get(`${host}/xapi/v1/ActiveCalls`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log('成功 獲取當前活躍呼叫的列表:', response.data);
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error activeCalls request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error activeCalls request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 查詢指定ID的活躍呼叫
export async function activeCallId(token: string, callid: string) {
  try {
    const response = await axios.get(`${host}/xapi/v1/ActiveCalls?$filter=Id eq ${callid}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log('成功 獲取當前活躍呼叫的列表:', response.data);
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error activeCallId request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error activeCallId request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 獲取當前 Queues 的列表
export async function getQueues(token: string) {
  try {
    const response = await axios.get(`${host}/xapi/v1/Queues`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log('成功 獲取當前 Queues 的列表:', response.data);
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getQueues request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getQueues request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 根據ID獲取指定的 Queue
export async function getQueuesById(token: string, id: string) {
  try {
    const response = await axios.get(`${host}/xapi/v1/Queues(${id})?expand=Agents`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log('成功 獲取當前 Queues 的列表:', response.data);
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getQueuesById request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getQueuesById request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 取得報告隊列中的代理統計信息
export async function getReportAgentsInQueueStatistics(token: string, queueDnStr: string, startDt: string, endDt: string, waitInterval: string) {
  try {
    const response = await axios.get(`${host}/xapi/v1/ReportAgentsInQueueStatistics/Pbx.GetAgentsInQueueStatisticsData(queueDnStr='${queueDnStr}',startDt=${startDt},endDt=${endDt},waitInterval='${waitInterval}')`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getReportAgentsInQueueStatistics request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getReportAgentsInQueueStatistics request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 取得 Agent 使用者
export async function getUsers(token: string, agentDn: string) {
  try {
    const response = await axios.get(`${host}/xapi/v1/Users?$filter=Number eq '${agentDn}'&$expand=ForwardingProfiles`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log('成功 獲取當前 Queues 的列表:', response.data);
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getUsers request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getUsers request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

