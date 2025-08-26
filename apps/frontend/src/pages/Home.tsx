// import InfoOutlineIcon from '@mui/icons-material/InfoOutline';
// import { useNavigate } from 'react-router-dom'
import { Fragment, useRef, useState, useEffect } from 'react';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  IconButton,
  Chip,
  Stack,
  Box,
  Switch,
  Button,
  LinearProgress,
  Alert,
  CircularProgress,
  TextField
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import InfoOutlineIcon from '@mui/icons-material/InfoOutline';

import GlobalSnackbar, { type GlobalSnackbarRef } from '../components/GlobalSnackbar';
import ProjectCustomersDialog from '../components/ProjectCustomersDialog';

import useProjectOutboundData from '../hooks/useProjectOutboundData';

import useUpdateBonsaleProject from '../hooks/api/useUpdateBonsaleProject';

export default function Home() {
  // WebSocket 狀態
  const [wsStatus, setWsStatus] = useState<'connecting'|'open'|'closed'|'error'>('connecting');
  const [wsMessage, setWsMessage] = useState<string>('');
  const [inputMessage, setInputMessage] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);

  // 發送訊息
  const sendMessage = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && inputMessage.trim()) {
      wsRef.current.send(inputMessage);
      setInputMessage('');
    }
  };

  // 連線 WebSocket
  // 注意：正式環境請改成後端 ws 服務實際網址
  const WS_URL = 'ws://localhost:4020';

  // 只在元件掛載時執行一次
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('open');
      console.log('WebSocket 連線成功');
    };
    ws.onmessage = (event) => {
      setWsMessage(event.data);
      console.log('收到 WebSocket 訊息:', event.data);
    };
    ws.onerror = (error) => {
      setWsStatus('error');
      console.error('WebSocket 錯誤:', error);
    };
    ws.onclose = () => {
      setWsStatus('closed');
      console.log('WebSocket 連線關閉');
    };

    return () => {
      ws.close();
    };
  }, []);

  // 引入 自定義 API Hook
  const { updateProject } = useUpdateBonsaleProject();
  
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null); // 用於跟踪當前展開的專案 ID

  const handleExpandClick = (isOpen: boolean, projectId?: string) => {
    if (isOpen && projectId) {
      setExpandedProjectId(projectId);
    } else {
      setExpandedProjectId(null);
    }
  }

  const snackbarRef = useRef<GlobalSnackbarRef>(null);

  const { projectOutboundData, setProjectOutboundData, isLoading: projectOutboundDataIsloading, loadMore, hasMore  } = useProjectOutboundData();
  const tableBoxRef = useRef<HTMLDivElement>(null);

  // 滾動到底自動加載
  const handleScroll = () => {
    const box = tableBoxRef.current;
    if (!box || !hasMore) return;
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 10) { // 10px buffer
      loadMore();
    }
  };
 
  // 開始撥打電話
  const handleStartOutbound = () => {

  };

  // 暫停撥打電話
  // const handlePauseOutbound = () => {

  // };

  // 停止撥打電話
  // const handleStopOutbound = () => {

  // };

  // 全部專案開始外撥
  const handleAllProjectStartOutbound = async () => {

  }

  // 切換專案啟用狀態
  const handleToggleProject = async (project: ProjectOutboundDataType) => {
    const { projectId, isEnable } = project;
    await updateProject(projectId, JSON.stringify(!isEnable))
    setProjectOutboundData(prev => 
      prev.map(item => {
        if (item.projectId === projectId) {
          (async () => {
            try {
              setProjectOutboundData(prevInner =>
                prevInner.map(innerItem =>
                  innerItem.projectId === projectId
                    ? { ...innerItem, isEnable: !isEnable }
                    : innerItem
                )
              );
            } catch (error) {
              console.error('Error fetching project customers:', error);
            }
          })();
          return { ...item, isEnable: !isEnable }; // 先切換 isEnable，projectCustomersDesc 由上面 async 處理
        }
        return item;
      })
    );
  };
    
  return (
    <>
      {/* WebSocket 狀態顯示 */}
      <Alert severity={wsStatus === 'open' ? 'success' : wsStatus === 'error' ? 'error' : 'info'} sx={{ mb: 2 }}>
        WebSocket 狀態：{wsStatus}
        {wsMessage && <Box sx={{ mt: 1 }}>收到訊息：{wsMessage}</Box>}
        {wsStatus === 'open' && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField
              size="small"
              placeholder="輸入訊息"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
            />
            <Button size="small" variant="contained" onClick={sendMessage}>
              發送
            </Button>
          </Stack>
        )}
      </Alert>
      <GlobalSnackbar ref={snackbarRef} />
      <Stack 
        direction='row'
        spacing={2}
        alignItems='center'
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          paddingY: 2,
          borderBottom: '1px solid #eee',
        }}
      >
        <Stack spacing={1}>
          <Stack direction="row" spacing={1}>
            <Alert severity="warning">
              自動外撥專案執行期間 暫停動作時，會同步掛斷當前通話，請警慎使用。
            </Alert>
            <Alert severity="info">
              暫停動作後可使用停止動作，將專案恢復成初始狀態。
            </Alert>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Button 
              variant="contained" 
              onClick={() => handleAllProjectStartOutbound()}
              sx={{
                margin: '12px 0',
                minWidth: '100px',
                bgcolor: (theme) => theme.palette.secondary.main, 
              }}
            >
              全部執行
            </Button> 
          </Stack>
        </Stack>
      </Stack>
      <Box 
        ref={tableBoxRef}
        sx={{ height: '100%', maxHeight:'100%', overflowY: 'scroll' }}
        onScroll={handleScroll}
      >
        <Table stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell align='center' sx={{ width: '20px' }}>
                啟用專案
              </TableCell>
              <TableCell align='center' sx={{ width: '120px' }}>
                專案名稱
              </TableCell>
              <TableCell align='center' sx={{ width: '20px' }}>
                狀態
              </TableCell>
              <TableCell align='center' sx={{ width: '20px' }}>
                分機
              </TableCell>
              <TableCell align='center' sx={{ width: '30px' }}>
                <Stack direction='row' alignItems='center' justifyContent='center'>
                  動作 
                </Stack>
              </TableCell>
              <TableCell align='center' sx={{ width: '20px' }}>
                撥打狀況
              </TableCell>
                <TableCell align='center' sx={{ width: '400px' }}>
                  當前撥打資訊
                </TableCell>
            </TableRow>
          </TableHead>
          <TableBody sx={{  backgroundColor: 'white' }}>
            {
              projectOutboundDataIsloading ?
                <TableRow>
                  <TableCell colSpan={8} sx={{ padding: 0 }}>
                    <LinearProgress />
                  </TableCell>
                </TableRow>
              : projectOutboundData.length == 0 &&
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ height: '100%', borderBottom: 'none' , color: '#888', py: 4, fontSize: '1.5rem' }}>
                    沒有名單
                  </TableCell>
                </TableRow>
            }
            {projectOutboundData.map((item, index) => {
              return (
                <Fragment key={item.projectId + index}>
                  <TableRow 
                    key={item.projectId}
                    sx={{
                      backgroundColor: item.callStatus === 4 ? '#f5f5f5' : item.callStatus === 3 ? '#FFF4F4' : 'inherit',
                      height: item.callStatus !== 0 ? '250px' : '100px',
                      transition: 'all 0.3s ease-in-out'
                    }}
                  >
                    <TableCell>
                      <Switch 
                        checked={item.isEnable}
                        onChange={() => handleToggleProject(item)}
                      />
                    </TableCell>
                    <TableCell align='center'>
                      {item.projectName}
                    </TableCell>
                    <TableCell align='center'>
                      <Chip label={
                        item.callStatus === 0 ? '未執行' :
                        item.callStatus === 1 ? '執行中' :
                        item.callStatus === 2 ? '執行完成' :
                        item.callStatus === 3 ? '執行失敗' :
                        item.callStatus === 4 ? '暫停執行' :
                        '未知狀態'
                      } sx={{ 
                        marginBottom: '4px',
                        width: '80px',
                        color: () => 
                          item.callStatus === 1  || 
                          item.callStatus === 2 
                          ? 'white' : 'black',
                        bgcolor: (theme) => 
                          item.callStatus === 0 ? theme.palette.primary.color50 :
                          item.callStatus === 1 ? theme.palette.primary.main :
                          item.callStatus === 2 ? theme.palette.primary.dark :
                          item.callStatus === 3 ? theme.palette.error.main :
                          item.callStatus === 4 ? theme.palette.warning.main :
                          theme.palette.warning.light
                      }} />
                    </TableCell>
                    <TableCell align='center'>
                      {item.extension}
                    </TableCell>
                    <TableCell align='center'>
                      <Stack direction='row'>
                        <IconButton 
                            onClick={() => handleStartOutbound()}
                          >
                          <PlayArrowIcon />
                        </IconButton>
                        <IconButton 
                          onClick={() => handleExpandClick(true, item.projectId)}
                        >
                          <InfoOutlineIcon /> 
                        </IconButton> 
                      </Stack>
                    </TableCell>
                    <TableCell align='left'>
                      <Stack>
                        <Chip label= '準備撥打' size="small"/>
                        {/* <Chip
                          label={
                            mainActionType(item.projectCallState) === 'init' ? '準備撥打' :
                            mainActionType(item.projectCallState) === 'active' ? '準備撥打' : 
                            mainActionType(item.projectCallState) === 'start' ? '開始撥號' :
                            mainActionType(item.projectCallState) === 'pause' ? '暫停撥打' :
                            mainActionType(item.projectCallState) === 'stop' ? '停止撥打' :
                            mainActionType(item.projectCallState) === 'waiting' ? '等待撥打' : 
                            mainActionType(item.projectCallState) === 'error' ? 
                            item.projectCallState === 'error - notAvailable' ? '人員勿擾' :
                            isAutoRestart ? '重新嘗試' : '撥打失敗' :
                            mainActionType(item.projectCallState) === 'recording' ? '撥打記錄' :
                            mainActionType(item.projectCallState) === 'calling' ? '撥打中' : 
                            mainActionType(item.projectCallState) === 'finish' ? '撥打完成' : 
                            mainActionType(item.projectCallState)
                          }
                          size="small"
                          sx={{ 
                            width: '80px',
                            marginBottom: '4px',
                            color: () => 
                              mainActionType(item.projectCallState) === 'calling' || 
                              mainActionType(item.projectCallState) === 'finish' 
                              ? 'white' : 'black',
                            bgcolor: (theme) => 
                              mainActionType(item.projectCallState) === 'active' ? theme.palette.warning.color50 :
                              mainActionType(item.projectCallState) === 'calling' ? theme.palette.warning.main :
                              mainActionType(item.projectCallState) === 'waiting' ? theme.palette.warning.color300 :
                              mainActionType(item.projectCallState) === 'error' ?
                              item.projectCallState === 'error - notAvailable' ? theme.palette.warning.color300 :
                              isAutoRestart ? theme.palette.error.color100 : theme.palette.error.main :
                              mainActionType(item.projectCallState) === 'recording' ? theme.palette.success.color300 :
                              mainActionType(item.projectCallState) === 'finish' ? theme.palette.success.color700 :
                              'default'
                          }}
                        /> */}
                      </Stack>
                    </TableCell>
                    <TableCell align='left'>
                      {item.projectCallData ? (
                        <Stack>
                          <Chip
                            label={`Phone: ${item.projectCallData.phone || '-'}`}
                            variant="outlined"
                            size="small"
                            sx={{ marginBottom: '4px' }}
                          />
                          {item.projectCallData.activeCall && (
                            <Stack sx={{ marginTop: '8px', width: '100%' }}>
                              <Chip
                                label={`Caller: ${item.projectCallData.activeCall.Caller || '-'}`}
                                variant="filled"
                                size="small"
                                sx={{ 
                                  marginBottom: '4px',
                                  bgcolor: (theme) => theme.palette.primary.color100,
                                }}
                              />
                              <Chip
                                label={`Callee: ${item.projectCallData.activeCall.Callee || '-'}`}
                                variant="filled"
                                size="small"
                                sx={{ 
                                  marginBottom: '4px',
                                  bgcolor: (theme) => theme.palette.primary.color50,
                                }}
                              />
                              <Chip
                                label={`Status: ${item.projectCallData.activeCall.Status || '-'}`}
                                color={item.projectCallData.activeCall.Status === 'Routing' ? 'primary' : 'default'}
                                size="small"
                                sx={{ 
                                  marginBottom: '4px',
                                  bgcolor: (theme) => 
                                    item.projectCallData?.activeCall?.Status === 'Routing' ? theme.palette.warning.main :
                                    item.projectCallData?.activeCall?.Status === 'Talking' ? theme.palette.success.color700 :
                                    theme.palette.primary.color50
                                }}
                              />
                              <Chip
                                label={`Last Change: ${new Date(item.projectCallData.activeCall.LastChangeStatus).toLocaleString() || '-'}`}
                                variant="outlined"
                                size="small"
                                sx={{ marginBottom: '4px' }}
                              />
                              <Chip
                                label={`Established At: ${new Date(item.projectCallData.activeCall.EstablishedAt).toLocaleString() || '-'}`}
                                variant="outlined"
                                size="small"
                                sx={{ marginBottom: '4px' }}
                              />
                              <Chip
                                label={`Server Time: ${new Date(item.projectCallData.activeCall.ServerNow).toLocaleString() || '-'}`}
                                variant="outlined"
                                size="small"
                              />
                            </Stack>
                          )}
                        </Stack>
                      ) : (
                        <Chip label="No Data" variant="outlined" size="small" />
                      )}
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
            {/* 懶加載時底部 loading 標誌 */}
            {projectOutboundDataIsloading && hasMore && (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ borderBottom: 'none', py: 2 }}>
                  <CircularProgress size={32} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table> 
      </Box>
      <ProjectCustomersDialog onOpen={Boolean(expandedProjectId)} onClose={()=>{handleExpandClick(false)}} projectId={expandedProjectId}/>
    </>
  );
};