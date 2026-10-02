export interface WebGatewayConfig {
    port?: number;
    authSecret?: string;
    host?: string;
}
export declare const webConnectorStatus: "placeholder";
export declare function startWebGateway(config?: WebGatewayConfig): void;
