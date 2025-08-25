import { useState, useEffect, useCallback, useRef } from 'react';
import useGetBonsaleAutoDial from './api/useGetBonsaleAutoDial';

const useProjectOutboundData = () => {
  const { getBonsaleAutoDial } = useGetBonsaleAutoDial();

  const [projectOutboundData, setProjectOutboundData] = useState<ProjectOutboundDataType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPage, setTotalPage] = useState(1);

  // 新增一個 ref 旗標
  const didInit = useRef(false);

  const fetchPage = useCallback(async (page: number) => {
    setIsLoading(true);
    try {
      const pageData = await getBonsaleAutoDial(page);
      setTotalPage(pageData.totalPage || 1);

      const dataList = pageData.list.map((item: Project) => ({
        appId: item.appId,
        appSecret: item.appSecret,
        callFlowId: item.callFlowId,
        projectId: item.projectId,
        projectName: item.projectInfo.projectName,
        startDate: new Date(item.projectInfo.startDate),
        endDate: new Date(item.projectInfo.endDate),
        callStatus: 0,
        extension: item.callFlow.phone,
        projectCallState: 'init',
        projectCallData: null,
        isEnable: item.projectInfo.isEnable,
        errorTimes: 0,
      }));
      
      setProjectOutboundData(prev => [...prev, ...dataList]);
    } catch (error) {
      console.error('Error fetching project auto-dial data:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [getBonsaleAutoDial]);

  // 初始化只載入第一頁
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setProjectOutboundData([]);
    fetchPage(1);
  }, [fetchPage]);

  // 懶加載下一頁
  const loadMore = useCallback(() => {
    if (currentPage < totalPage && !isLoading) {
      const nextPage = currentPage + 1;
      setCurrentPage(nextPage);
      fetchPage(nextPage);
    }
  }, [currentPage, totalPage, isLoading, fetchPage]);

  return { projectOutboundData, setProjectOutboundData, isLoading, loadMore, hasMore: currentPage < totalPage };
};

export default useProjectOutboundData;