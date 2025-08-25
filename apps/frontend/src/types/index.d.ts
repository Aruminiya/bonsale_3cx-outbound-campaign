declare global {

  interface ProjectOutboundDataType {
    appId: string
    appSecret: string
    callFlowId: string
    projectId: string
    projectName: string
    startDate: Date;
    endDate: Date;
    callStatus: number
    extension: string
    // projectCustomersDesc: ProjectCustomersDesc[]
    projectCallState: string // 撥打狀態
    projectCallData: {
      id: string;
      phone: string;
      callFlowId: string;
      projectId: string;
      activeCall?: {
        Id: number;
        Caller: string;
        Callee: string;
        Status: string;
        LastChangeStatus: string;
        EstablishedAt: string;
        ServerNow: string;
      };
    } | null
    isEnable: boolean
  }

  interface ProjectCustomersDesc {
    projectId: string;
    project: {
    id: string;
    createdAt: string;
    createdUsername: string;
    updatedAt: string;
    updatedUsername: string;
    deletedAt: string | null;
    projectName: string;
    description: string | null;
    startDate: string;
    endDate: string;
    isEnable: boolean;
    isParent: boolean;
    parentProjectId: string | null;
    };
    customerId: string;
    customer: {
    id: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    memberName: string;
    createUserId: string;
    createUserName: string;
    createTime: string;
    customerType: string;
    name: string | null;
    phone: string;
    localAreaCode: string | null;
    localPhone: string | null;
    localExt: string | null;
    email: string | null;
    marriage: string | null;
    birthday: string | null;
    description: string | null;
    grade: string | null;
    communicationAddressZipCode: string | null;
    communicationAddressCounty: string | null;
    communicationAddressCity: string | null;
    communicationAddressStreet: string | null;
    shipAddressSame: string | null;
    shipAddressZipCode: string | null;
    shipAddressCounty: string | null;
    shipAddressCity: string | null;
    shipAddressStreet: string | null;
    invoiceAddressSame: string | null;
    invoiceAddressZipCode: string | null;
    invoiceAddressCounty: string | null;
    invoiceAddressCity: string | null;
    invoiceAddressStreet: string | null;
    taxIdNo: string | null;
    workingHourFrom: string | null;
    workingMinFrom: string | null;
    workingHourTo: string | null;
    workingMinTo: string | null;
    restHourFrom: string | null;
    restMinFrom: string | null;
    restHourTo: string | null;
    restMinTo: string | null;
    gender: string | null;
    companyName: string | null;
    department: string | null;
    jobTitle: string | null;
    };
    ownerUsername: string;
    ownerUser: {
    id: string;
    createdAt: string;
    createdUsername: string;
    updatedAt: string;
    updatedUsername: string;
    deletedAt: string | null;
    username: string;
    displayName: string;
    role: string;
    position: string | null;
    zone: string;
    supervisorUsername: string | null;
    phone: string;
    isEnable: boolean;
    isProtect: boolean;
    isAssign: boolean;
    path: string;
    userId: string;
    realName: string;
    email: string;
    fullAccess: number;
    salePointId: string;
    salePointIds: string;
    departmentId: string;
    isLook: number;
    isDoctor: string;
    isMaster: number;
    isReturn: number;
    isFirstUpdate: string | null;
    customerId: string;
    theme: string;
    blockedTime: string;
    lastChangeTime: string;
    cardNo: string;
    deleted: number;
    blocked: number;
    };
    description: string | null;
    createdAt: string;
    createUsername: string;
    updatedAt: string;
    updatedUsername: string;
    lastVisitedUsername: string | null;
    lastVisitedAt: string | null;
    lastVisitedResult: string;
    introducedAt: string | null;
    quotedAt: string | null;
    negotiatedAt: string | null;
    signedAt: string | null;
    closedAt: string | null;
    callCount: number;
    nextCallAfter: string | null;
    callStatus: number;
  }
  interface Project {
    d: string;
    projectId: string;
    projectInfo: {
      id: string;
      createdAt: string;
      createdUsername: string;
      updatedAt: string;
      updatedUsername: string;
      deletedAt: string | null;
      projectName: string;
      description: string | null;
      startDate: string;
      endDate: string;
      isEnable: boolean;
      isParent: boolean;
      parentProjectId: string | null;
    };
    callFlowId: string;
    callFlow: {
      id: string;
      createdAt: string;
      createdUsername: string;
      updatedAt: string;
      updatedUsername: string;
      deletedAt: string | null;
      username: string;
      displayName: string;
      role: string;
      position: string | null;
      zone: string;
      supervisorUsername: string;
      phone: string;
      isEnable: boolean;
      isProtect: boolean;
      isAssign: boolean;
      path: string;
      userId: string;
      realName: string;
      email: string;
      fullAccess: number;
      salePointId: string;
      salePointIds: string;
      departmentId: string;
      isLook: number;
      isDoctor: string;
      isMaster: number;
      isReturn: number;
      isFirstUpdate: string | null;
      customerId: string;
      theme: string;
      blockedTime: string;
      lastChangeTime: string;
      cardNo: string;
      deleted: number;
      blocked: number;
    };
    transferExtension: string;
    inboundExtension: string;
    startDate: string;
    endDate: string;
    startTime: string;
    endTime: string;
    maxCalls: number;
    retryAfter: number;
    timeUnit: string;
    recurrence: string | null;
    createdAt: string;
    createdUserId: string;
    updatedAt: string;
    updatedUserId: string;
    lastExecutedAt: string | null;
    pbxBaseUrl: string;
    appId: string;
    appSecret: string;
    customer: Customer;
    projectCustomers: {
      projectId: string;
      customerId: string;
      ownerUsername: string;
      description: string | null;
      createdAt: string;
      createUsername: string;
      updatedAt: string;
      updatedUsername: string;
      lastVisitedUsername: string | null;
      lastVisitedAt: string | null;
      lastVisitedResult: string;
      introducedAt: string | null;
      quotedAt: string | null;
      negotiatedAt: string | null;
      signedAt: string | null;
      closedAt: string | null;
      callCount: number;
      nextCallAfter: string | null;
      callStatus: number;
    }[];
  }
  interface Customer {
    id: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    memberName: string;
    createUserId: string;
    createUserName: string;
    createTime: string;
    customerType: string;
    name: string | null;
    phone: string;
    localAreaCode: string | null;
    localPhone: string | null;
    localExt: string | null;
    email: string | null;
    marriage: string | null;
    birthday: string | null;
    description: string | null;
    grade: string | null;
    communicationAddressZipCode: string | null;
    communicationAddressCounty: string | null;
    communicationAddressCity: string | null;
    communicationAddressStreet: string | null;
    shipAddressSame: string | null;
    shipAddressZipCode: string | null;
    shipAddressCounty: string | null;
    shipAddressCity: string | null;
    shipAddressStreet: string | null;
    invoiceAddressSame: string | null;
    invoiceAddressZipCode: string | null;
    invoiceAddressCounty: string | null;
    invoiceAddressCity: string | null;
    invoiceAddressStreet: string | null;
    taxIdNo: string | null;
    workingHourFrom: string | null;
    workingMinFrom: string | null;
    workingHourTo: string | null;
    workingMinTo: string | null;
    restHourFrom: string | null;
    restMinFrom: string | null;
    restHourTo: string | null;
    restMinTo: string | null;
    gender: string | null;
    companyName: string | null;
    department: string | null;
    jobTitle: string | null;
  };
  interface ToCallResponse {
    message: string;
  };

  interface ProjectOutboundWsMessage {
    projectId: string,
    action: `${'active' | 'start' | 'stop' | 'pause' | 'paused' | 'calling' | 'waiting' | 'recording'}${'' | ` - ${string}`}`, // 可以添加後綴來表示不同的狀態
    callFlowId: string,
    projectCallData: {
      id: string;
      phone: string;
      callFlowId: string;
      projectId: string;
      activeCall?: {
        Id: number;
        Caller: string;
        Callee: string;
        Status: string;
        LastChangeStatus: string;
        EstablishedAt: string;
        ServerNow: string;
      };
    } | null,
  }

  interface Call {
    requestId: string;
    phone: string;
    projectId: string;
    activeCall?: {
      Id: number;
      Caller: string;
      Callee: string;
      Status: string;
      LastChangeStatus: string;
      EstablishedAt: string;
      ServerNow: string;
    };
  }

  type BonsaleWebHook =
    | {
        type: "auto-dial.created";
        body: {
          Id: string;
          projectId: string;
          callFlowId: string;
        };
        query: string;
        user: string;
      }
    | {
        type: "auto-dial.updated";
        body: {
          Id: string;
          projectId: string;
          callFlowId: string;
        };
        query: string;
        user: string;
      }
    | {
        type: "project.updated";
        body: {
          Id: string;
          isEnable: boolean;
        };
        query: string;
        user: string;
      };
}

export {};