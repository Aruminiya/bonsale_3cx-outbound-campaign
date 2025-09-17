import redisClient from '../services/redis';
import Project from './project';
import { logWithTimestamp, errorWithTimestamp } from '../util/timestamp';

export class ProjectManager {
  private static readonly PROJECT_PREFIX = 'project:';
  private static readonly ACTIVE_PROJECTS_SET = 'active_projects';

  // 儲存專案到 Redis
  static async saveProject(project: Project): Promise<void> {
    try {
      const projectKey = `${this.PROJECT_PREFIX}${project.projectId}`;
      
      // 將專案序列化（注意：WebSocket 連接不能序列化，需要特殊處理）
      const projectData = {
        grant_type: project.grant_type,
        client_id: project.client_id,
        client_secret: project.client_secret,
        callFlowId: project.callFlowId,
        projectId: project.projectId,
        state: project.state,
        error: project.error || '',
        access_token: project.access_token || '',
        caller: project.caller ? JSON.stringify(project.caller) : '',
        agentQuantity: project.agentQuantity.toString(),
        recurrence: project.recurrence || '',
        // ws_3cx 不儲存，因為 WebSocket 無法序列化
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // 儲存專案資料
      await redisClient.hSet(projectKey, projectData);
      
      // 將專案 ID 加入活躍專案集合
      await redisClient.sAdd(this.ACTIVE_PROJECTS_SET, project.projectId);
      
      // 設置過期時間（例如：24小時）
      // await redisClient.expire(projectKey, 24 * 60 * 60);
      
      logWithTimestamp(`專案 ${project.projectId} 已儲存到 Redis`);
    } catch (error) {
      errorWithTimestamp('儲存專案到 Redis 失敗:', error);
      throw error;
    }
  }

  // 從 Redis 取得專案
  static async getProject(projectId: string): Promise<Project | null> {
    try {
      const projectKey = `${this.PROJECT_PREFIX}${projectId}`;
      const projectData = await redisClient.hGetAll(projectKey);
      
      if (!projectData || Object.keys(projectData).length === 0) {
        return null;
      }

      // 重建 Project 實例
      const project = new Project(
        projectData.client_id,
        projectData.client_secret,
        projectData.callFlowId,
        projectData.projectId,
        projectData.state as 'active' | 'stop',
        projectData.error || null,
        projectData.access_token || null,
        projectData.caller ? JSON.parse(projectData.caller) : null,
        projectData.latestCallRecord ? JSON.parse(projectData.latestCallRecord) : [],
        parseInt(projectData.agentQuantity) || 0,
        projectData.recurrence || null
      );

      return project;
    } catch (error) {
      errorWithTimestamp('從 Redis 取得專案失敗:', error);
      return null;
    }
  }

  // 取得所有活躍專案 ID
  static async getAllActiveProjectIds(): Promise<string[]> {
    try {
      return await redisClient.sMembers(this.ACTIVE_PROJECTS_SET);
    } catch (error) {
      errorWithTimestamp('取得活躍專案列表失敗:', error);
      return [];
    }
  }

  // 取得所有活躍專案
  static async getAllActiveProjects(): Promise<Project[]> {
    try {
      const projectIds = await this.getAllActiveProjectIds();
      const projects: Project[] = [];
      
      for (const projectId of projectIds) {
        const project = await this.getProject(projectId);
        if (project) {
          projects.push(project);
        }
      }
      
      return projects;
    } catch (error) {
      errorWithTimestamp('取得所有活躍專案失敗:', error);
      return [];
    }
  }

  // 更新專案狀態
  static async updateProjectAction(projectId: string, state: 'active' | 'stop'): Promise<void> {
    try {
      const projectKey = `${this.PROJECT_PREFIX}${projectId}`;
      await redisClient.hSet(projectKey, {
        state: state,
        updatedAt: new Date().toISOString()
      });
      
      logWithTimestamp(`專案 ${projectId} 狀態更新為: ${state}`);
    } catch (error) {
      errorWithTimestamp('更新專案狀態失敗:', error);
      throw error;
    }
  }

  // 更新專案 Access Token
  static async updateProjectAccessToken(projectId: string, accessToken: string): Promise<void> {
    try {
      const projectKey = `${this.PROJECT_PREFIX}${projectId}`;
      await redisClient.hSet(projectKey, {
        access_token: accessToken,
        updatedAt: new Date().toISOString()
      });
      
      logWithTimestamp(`專案 ${projectId} Access Token 已更新`);
    } catch (error) {
      errorWithTimestamp('更新專案 Access Token 失敗:', error);
      throw error;
    }
  }

  // 檢查專案是否存在
  static async projectExists(projectId: string): Promise<boolean> {
    try {
      const projectKey = `${this.PROJECT_PREFIX}${projectId}`;
      const exists = await redisClient.exists(projectKey);
      return exists === 1;
    } catch (error) {
      errorWithTimestamp('檢查專案是否存在失敗:', error);
      return false;
    }
  }

  // 移除專案
  static async removeProject(projectId: string): Promise<void> {
    try {
      const projectKey = `${this.PROJECT_PREFIX}${projectId}`;
      
      // 刪除專案資料
      await redisClient.del(projectKey);
      
      // 從活躍專案集合中移除
      await redisClient.sRem(this.ACTIVE_PROJECTS_SET, projectId);
      
      logWithTimestamp(`專案 ${projectId} 已從 Redis 移除`);
    } catch (error) {
      errorWithTimestamp('從 Redis 移除專案失敗:', error);
      throw error;
    }
  }

  // 清除所有專案
  static async clearAllProjects(): Promise<void> {
    try {
      const projectIds = await this.getAllActiveProjectIds();
      
      for (const projectId of projectIds) {
        await this.removeProject(projectId);
      }
      
      logWithTimestamp('所有專案已清除');
    } catch (error) {
      errorWithTimestamp('清除所有專案失敗:', error);
      throw error;
    }
  }

  // 取得專案統計資訊
  static async getProjectStats(): Promise<{
    totalProjects: number;
    activeProjects: string[];
    stopProjects: number;
    activeProjectsCount: number;
  }> {
    try {
      const projectIds = await this.getAllActiveProjectIds();
      const projects = await this.getAllActiveProjects();
      
      const stopProjects = projects.filter(p => p.state === 'stop').length;
      const activeProjectsCount = projects.filter(p => p.state === 'active').length;
      
      return {
        totalProjects: projectIds.length,
        activeProjects: projectIds,
        stopProjects,
        activeProjectsCount
      };
    } catch (error) {
      errorWithTimestamp('取得專案統計資訊失敗:', error);
      return {
        totalProjects: 0,
        activeProjects: [],
        stopProjects: 0,
        activeProjectsCount: 0
      };
    }
  }
}
