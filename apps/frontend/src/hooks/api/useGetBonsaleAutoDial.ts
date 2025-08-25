import axios from 'axios';
import { useCallback, useState } from 'react';

// 取得本機 IP domain
const { hostname } = window.location;
const api_protocol = import.meta.env.VITE_API_PROTOCOL;
const port = import.meta.env.VITE_API_PORT;
const domain = import.meta.env.VITE_DOMAIN;
const HTTP_HOST = domain === 'localhost'? `${api_protocol}://${hostname}:${port}` :`${api_protocol}://${domain}:${port}`;

export default function useGetBonsaleAutoDial() {
  const [isLoading, setIsLoading] = useState(false);

  const getBonsaleAutoDial = useCallback(async (page: number = 1) => {
    setIsLoading(true);
    try {
      const queryString = new URLSearchParams({
        // limit: '-1', // 暫時不使用 limit，因為會導致資料量過大
        page: page.toString(),
        sort: 'created_at+desc'
      });
      const response = await axios.get(`${HTTP_HOST}/api/bonsale/project/auto-dial?${queryString}`);
      return response.data;
    } catch (error) {
      console.error('Error updating call status:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { getBonsaleAutoDial, isLoading };
}