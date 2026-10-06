export type WorkItemProviderId = "azure-devops";

export interface WorkItemRepositoryRef {
  id: string;
}

export interface WorkItemIdentity {
  id: string;
  displayName?: string | undefined;
  uniqueName?: string | undefined;
}

export type WorkItemRelationKind =
  | "work-item"
  | "pull-request"
  | "commit"
  | "artifact"
  | "hyperlink";

export interface WorkItemRelation {
  kind: WorkItemRelationKind;
  relation: string;
  url: string;
  id?: string | undefined;
  name?: string | undefined;
}

export interface WorkItemSnapshot {
  provider: WorkItemProviderId;
  project: string;
  repository: WorkItemRepositoryRef;
  id: number;
  revision: number;
  type: string;
  title: string;
  description: string;
  state: string;
  tags: string[];
  assignedTo?: WorkItemIdentity | undefined;
  author?: WorkItemIdentity | undefined;
  createdAt?: string | undefined;
  changedAt?: string | undefined;
  relations: WorkItemRelation[];
}

export interface WorkItemComment {
  id: number;
  body: string;
  author?: WorkItemIdentity | undefined;
  createdAt?: string | undefined;
  modifiedAt?: string | undefined;
}

export interface WorkItemDiscussion {
  comments: WorkItemComment[];
  truncated: boolean;
}

export interface WorkItemSearchResult {
  id: number;
  title: string;
  state: string;
  type: string;
  url: string;
}

export type WorkItemMutation =
  | {
      kind: "tags";
      add?: string[] | undefined;
      remove?: string[] | undefined;
    }
  | {
      kind: "state";
      state: string;
    }
  | {
      kind: "hyperlink";
      url: string;
      comment?: string | undefined;
    };

export interface WorkItemReader {
  getWorkItem(id: number): Promise<WorkItemSnapshot>;
  getComments(id: number): Promise<WorkItemDiscussion>;
}

export interface WorkItemCommentPublisher {
  addComment(id: number, body: string): Promise<WorkItemComment>;
  editComment(id: number, commentId: number, body: string): Promise<WorkItemComment>;
}

export interface WorkItemMutator {
  updateWorkItem(params: {
    id: number;
    expectedRevision: number;
    mutations: WorkItemMutation[];
  }): Promise<WorkItemSnapshot>;
}

export interface WorkItemSearch {
  searchWorkItems(params: {
    terms: string[];
    excludeId?: number | undefined;
    max?: number | undefined;
  }): Promise<{ items: WorkItemSearchResult[]; incomplete: boolean }>;
}

export type WorkItemProvider =
  & WorkItemReader
  & WorkItemCommentPublisher
  & WorkItemMutator
  & WorkItemSearch;
