import axios from 'axios';
import { useCallback, useState } from 'react';

// 取得本機 IP domain
const { hostname } = window.location;
const api_protocol = import.meta.env.VITE_API_PROTOCOL;
const port = import.meta.env.VITE_API_PORT;
const domain = import.meta.env.VITE_DOMAIN;
const HTTP_HOST = domain === 'localhost'? `${api_protocol}://${hostname}:${port}` :`${api_protocol}://${domain}:${port}`;

export default function useGetOneBonsaleAutoDial() {
  const [isLoading, setIsLoading] = useState(false);

  const getOneBonsaleAutoDial = useCallback(async (projectId: string, callFlowId: string) => {
    setIsLoading(true);
    try {
      const response = await axios.get(`${HTTP_HOST}/api/bonsale/project/${projectId}/auto-dial/${callFlowId}`);
      return response.data;
    } catch (error) {
      console.error('Error getting single auto-dial data:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { getOneBonsaleAutoDial, isLoading };
}