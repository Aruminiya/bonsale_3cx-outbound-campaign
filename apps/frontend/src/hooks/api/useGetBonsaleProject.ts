import axios from 'axios';
import { useCallback, useState } from 'react';

// 取得本機 IP domain
const { hostname } = window.location;
const api_protocol = import.meta.env.VITE_API_PROTOCOL;
const port = import.meta.env.VITE_API_PORT;
const domain = import.meta.env.VITE_DOMAIN;
const HTTP_HOST = domain === 'localhost'? `${api_protocol}://${hostname}:${port}` :`${api_protocol}://${domain}:${port}`;

export default function useGatBonsaleProject() {
  const [isLoading, setIsLoading] = useState(false);

  const getBonsaleProject = useCallback(async (projectId: string, page: number = 1) => {
    setIsLoading(true);
    try {
      // 將專案中的客戶電話號碼提取出來
      const queryString = new URLSearchParams({
        // limit: '-1',
        page: page.toString(),
        projectIds: projectId
      });
      const response = await axios.get(`${HTTP_HOST}/api/bonsale/project?${queryString}`);
      return response.data;
    } catch (error) {
      console.error('Error updating call status:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { getBonsaleProject, isLoading };
}