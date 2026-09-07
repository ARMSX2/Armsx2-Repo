export class SourceGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceGenerationError";
  }
}

export class UpstreamSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamSyncError";
  }
}
