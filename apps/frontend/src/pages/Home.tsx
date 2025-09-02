// import InfoOutlineIcon from '@mui/icons-material/InfoOutline';
// import { useNavigate } from 'react-router-dom'
import { Fragment, useRef, useState, useEffect, useMemo } from 'react';
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
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import InfoOutlineIcon from '@mui/icons-material/InfoOutline';

import GlobalSnackbar, { type GlobalSnackbarRef } from '../components/GlobalSnackbar';
import ProjectCustomersDialog from '../components/ProjectCustomersDialog';

import useProjectOutboundData from '../hooks/useProjectOutboundData';

import useUpdateBonsaleProject from '../hooks/api/useUpdateBonsaleProject';

type SendMessagePayload = {
  event: string;
  payload: {
    project?: {
      callFlowId: string;
      projectId: string;
      client_id: string;
      client_secret: string;
      action: string;
      error: string | null;
    };
    // 可以根據需要添加其他類型的 payload
  };
};

// WebSocket 訊息中的專案資料結構
type WebSocketProject = {
  projectId: string;
  callFlowId: string;
  action: string;
  client_id: string;
  agentQuantity: number;
  caller: Array<{
    dn: string;
    type: string;
    devices: Array<{
      dn: string;
      device_id: string;
      user_agent: string;
    }>;
    participants: Array<{
      id: number;
      status: string;
      party_caller_name: string;
      party_dn: string;
      party_caller_id: string;
      device_id: string;
      party_dn_type: string;
      direct_control: boolean;
      callid: number;
      legid: number;
      dn: string;
    }>;
  }>;
  access_token: string;
  createdAt: string;
  updatedAt: string;
};

type WebSocketMessage = {
  event: string;
  payload: {
    allProjects: WebSocketProject[];
    stats: {
      totalProjects: number;
      activeProjects: string[];
      initProjects: number;
      activeProjectsCount: number;
    };
    timestamp: string;
    triggeredBy: string;
  };
};

export default function Home() {
  // WebSocket 狀態
  const [wsStatus, setWsStatus] = useState<'connecting'|'open'|'closed'|'error'>('connecting');
  const [wsMessage, setWsMessage] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);

  // 發送 WS 訊息
  const sendMessage = (message: SendMessagePayload) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not open or message is empty');
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

  // 解析 WebSocket 訊息
  const parsedWsMessage = useMemo((): WebSocketMessage | null => {
    if (!wsMessage) return null;
    try {
      return JSON.parse(wsMessage);
    } catch (error) {
      console.error('解析 WebSocket 訊息失敗:', error);
      return null;
    }
  }, [wsMessage]);

  // 處理專案通話訊息的映射
  const projectCallMessageMap = useMemo(() => {
    if (!parsedWsMessage?.payload?.allProjects) return new Map<string, WebSocketProject>();
    
    const map = new Map<string, WebSocketProject>();
    parsedWsMessage.payload.allProjects.forEach((project: WebSocketProject) => {
      map.set(project.projectId, project);
    });
    return map;
  }, [parsedWsMessage]);

  // 根據專案 ID 獲取通話訊息
  const getProjectCallMessage = (projectId: string): WebSocketProject | undefined => {
    return projectCallMessageMap.get(projectId);
  };
 
  // 開始撥打電話
  const handleStartOutbound = (project: ProjectOutboundDataType) => {
    const message = {
      event: 'startOutbound',
      payload: {
        project: {
          callFlowId: project.callFlowId,
          client_id: project.appId,
          client_secret: project.appSecret,
          projectId: project.projectId,
          action: 'init',
          error: null
        }
      }
    }

    sendMessage(message);
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
      <Alert 
        severity={wsStatus === 'open' ? 'success' : wsStatus === 'closed' ? 'error' : 'info'}
        sx={{ mb: 2 }}
      >
        WebSocket 狀態：{wsStatus}
        {wsMessage && <Box sx={{ mt: 1 }}>收到訊息：{wsMessage}</Box>}
        {wsStatus === 'open' && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            
            {/* <Button size="small" variant="contained" onClick={() => sendMessage('測試訊息發送')}>
              測試訊息發送
            </Button> */}
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
                      minHeight: '120px',
                      '& .MuiTableCell-root': {
                        verticalAlign: 'top',
                        paddingY: '16px'
                      },
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
                          onClick={() => handleStartOutbound(item)}
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
                    <TableCell align='center'>
                      <Stack spacing={1} alignItems="center">
                        <Chip 
                          label="準備撥打" 
                          size="small"
                          variant="outlined"
                          sx={{ fontSize: '0.7rem' }}
                        />
                        {/* 顯示 WebSocket 中的動態狀態 */}
                        {(() => {
                          const projectWsData = getProjectCallMessage(item.projectId);
                          if (projectWsData) {
                            const actionLabel = projectWsData.action === 'init' ? '初始化' : 
                                              projectWsData.action === 'active' ? '執行中' : 
                                              projectWsData.action;
                            return (
                              <Chip
                                label={actionLabel} 
                                size="small" 
                                sx={{ 
                                  fontSize: '0.7rem',
                                  fontWeight: 'bold',
                                  bgcolor: (theme) => 
                                    projectWsData.action === 'init' ? theme.palette.warning.main :
                                    projectWsData.action === 'active' ? theme.palette.success.main :
                                    theme.palette.primary.main,
                                  color: 'white'
                                }}
                              />
                            );
                          }
                          return null;
                        })()}
                      </Stack>
                    </TableCell>
                    <TableCell align='left'>
                      {(() => {
                        const projectWsData = getProjectCallMessage(item.projectId);
                        
                        if (!projectWsData?.caller || projectWsData.caller.length === 0) {
                          return <Chip label="無分機資料" variant="outlined" size="small" />;
                        }

                        return (
                          <Stack spacing={2}>
                            {projectWsData.caller.map((caller, callerIndex) => (
                              <Box 
                                key={`${caller.dn}-${callerIndex}`}
                                sx={{
                                  border: '1px solid #e0e0e0',
                                  borderRadius: '8px',
                                  padding: '12px',
                                  backgroundColor: '#fafafa'
                                }}
                              >
                                {/* 分機標題 */}
                                <Stack direction="row" spacing={1} sx={{ marginBottom: '8px' }}>
                                  <Chip
                                    label={`分機 ${caller.dn}`}
                                    variant="filled"
                                    size="small"
                                    sx={{ 
                                      fontWeight: 'bold',
                                      bgcolor: (theme) => theme.palette.primary.main,
                                      color: 'white'
                                    }}
                                  />
                                  {caller.devices?.map((device, deviceIndex) => (
                                    <Chip
                                      key={`device-${deviceIndex}`}
                                      label={`Device: ${device.dn}`}
                                      variant="outlined"
                                      size="small"
                                      sx={{ fontSize: '0.7rem' }}
                                    />
                                  ))}
                                </Stack>

                                {/* 通話狀態 */}
                                {caller.participants?.length > 0 ? (
                                  <Stack spacing={1}>
                                    <Box sx={{ fontSize: '0.8rem', fontWeight: 'bold', color: '#666' }}>
                                      通話中：
                                    </Box>
                                    {caller.participants.map((participant, participantIndex) => (
                                      <Box 
                                        key={`participant-${participantIndex}`}
                                        sx={{
                                          backgroundColor: 'white',
                                          padding: '8px',
                                          borderRadius: '4px',
                                          border: '1px solid #ddd'
                                        }}
                                      >
                                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: '4px' }}>
                                          <Chip
                                            label={`狀態: ${participant.status}`}
                                            size="small"
                                            sx={{ 
                                              bgcolor: (theme) => 
                                                participant.status === 'Dialing' ? theme.palette.warning.main :
                                                participant.status === 'Connected' ? theme.palette.success.main :
                                                theme.palette.primary.main,
                                              color: 'white',
                                              fontWeight: 'bold'
                                            }}
                                          />
                                          {participant.party_caller_id && (
                                            <Chip
                                              label={`撥打: ${participant.party_caller_id}`}
                                              variant="outlined"
                                              size="small"
                                              sx={{ fontSize: '0.7rem' }}
                                            />
                                          )}
                                          <Chip
                                            label={`Call ID: ${participant.callid}`}
                                            variant="outlined"
                                            size="small"
                                            sx={{ fontSize: '0.7rem' }}
                                          />
                                        </Stack>
                                      </Box>
                                    ))}
                                  </Stack>
                                ) : (
                                  <Box sx={{ textAlign: 'center', padding: '8px' }}>
                                    <Chip
                                      label="分機空閒"
                                      size="small"
                                      sx={{ 
                                        bgcolor: (theme) => theme.palette.success.color300,
                                        color: 'white',
                                        fontWeight: 'bold'
                                      }}
                                    />
                                  </Box>
                                )}
                              </Box>
                            ))}
                            
                            {/* 專案統計資訊 */}
                            <Box 
                              sx={{ 
                                marginTop: '12px', 
                                padding: '8px', 
                                backgroundColor: '#e3f2fd', 
                                borderRadius: '6px',
                                border: '1px solid #2196f3'
                              }}
                            >
                              <Stack direction="row" spacing={1} sx={{ justifyContent: 'center' }}>
                                <Chip
                                  label={`分機數: ${projectWsData.agentQuantity}`}
                                  variant="outlined"
                                  size="small"
                                  sx={{ fontSize: '0.7rem' }}
                                />
                              </Stack>
                            </Box>
                          </Stack>
                        );
                      })()}
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