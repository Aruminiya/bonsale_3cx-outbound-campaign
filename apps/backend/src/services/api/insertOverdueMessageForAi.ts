import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const host = process.env.HTTP_HOST_MESSAGE_FOR_AI;

if (!host) {
  throw new Error('環境變數 HTTP_HOST_3CX 未定義，請檢查 .env 文件');
}

// AI 撥打所需的 API
/* TODO:
  為什麼要有這個 API ?
  詳細原因我再去問 PY
*/
export async function post9000Dummy(description: string, description2: string, phone: string): Promise<{ success: boolean; data?: any; error?: { errorCode: string; error: string } }> {
  try {
    const response = await axios.post(`${host}/InsertOverdueMessageForAi`, {
        CaseNo: description,
        Phone: phone,
        ResultCode: "9000",
        ContentText: "",
        SourceUrl: description2
      }, {
      headers: {
        Authorization: 'dummy',
      },
    });
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error post9000Dummy request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error post9000Dummy request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}

// AI 撥打所需的 API 2
/* TODO:
  為什麼要有這個 API ?
  詳細原因我再去問 PY
*/
export async function post9000(description: string, description2: string, phone: string): Promise<{ success: boolean; data?: any; error?: { errorCode: string; error: string } }> {
  try {
    const response = await axios.post(`${description2}/InsertOverdueMessageForAi`, {
        CaseNo: description,
        Phone: phone,
        ResultCode: "9000",
        ContentText: "",
      }, {
      headers: {
        Authorization: 'Basic gsdigu6445283jagdfstg',
      },
    });
    // 回傳 API 的回應
    return { success: true, data: response.data }; // 返回成功
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    console.error('Error post9000 request:', axiosError.message);
    return {
      success: false,
      error: {
        errorCode: axiosError.response?.status?.toString() || '500',
        error: `Error post9000 request: ${axiosError.message}`,
      },
    }; // 返回錯誤
  }
}