import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const host = process.env.HTTP_HOST_3CX;

if (!host) {
  throw new Error('環境變數 HTTP_HOST_3CX 未定義，請檢查 .env 文件');
}

// 取得 3CX token
export async function get3cxToken(client_id: string, client_secret: string) {
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', client_id);
    params.append('client_secret', client_secret);

    const response = await axios.post(`${host}/connect/token`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error get3cxToken request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error get3cxToken request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 撥打電話
export async function makeCall(token: string, dn: string, device_id: string, reason: string, destination: string, timeout = 30) {
  try {
    const response = await axios.post(
      `${host}/callcontrol/${dn}/devices/${device_id}/makecall`,
      { reason, destination, timeout },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error makeCall request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error makeCall request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 掛斷當前撥號的對象
export async function hangupCall(token: string, dn: string, id: string) {
  try {
    const response = await axios.post(
      `${host}/callcontrol/${dn}/participants/${id}/drop`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log('成功 掛斷電話請求:', response.data);
    return response.data; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error hangupCall request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error hangupCall request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 獲取撥打者資訊
export async function getCaller(token: string, type: 'Wqueue' | 'Wextension' | 'Wroutepoint' = 'Wextension') {
  try {
    const response = await axios.get(`${host}/callcontrol`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const caller = response.data.filter((item: { type: string }) => item.type === type);
    if (!caller || caller.length === 0) {
      return {
        success: false,
        error: { 
          errorCode: '404', 
          error: `Caller type ${type} not found` 
        },
      }; // 返回錯誤
    }

    return { success: true, data: caller }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getCaller request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getCaller request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// 獲取參與者資訊
export async function getParticipants(token: string, dn: string) {
  try {
    const response = await axios.get(`${host}/callcontrol/${dn}/participants`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error getParticipants request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error getParticipants request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}