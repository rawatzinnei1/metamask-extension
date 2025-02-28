import { ControllerMessenger } from '@metamask/base-controller';
import AuthenticationController, {
  AllowedActions,
  AllowedEvents,
  AuthenticationControllerState,
} from './authentication-controller';
import {
  mockEndpointAccessToken,
  mockEndpointGetNonce,
  mockEndpointLogin,
} from './mocks/mockServices';
import { MOCK_ACCESS_TOKEN, MOCK_LOGIN_RESPONSE } from './mocks/mockResponses';

const mockSignedInState = (): AuthenticationControllerState => ({
  isSignedIn: true,
  sessionData: {
    accessToken: 'MOCK_ACCESS_TOKEN',
    expiresIn: new Date().toString(),
    profile: {
      identifierId: MOCK_LOGIN_RESPONSE.profile.identifier_id,
      profileId: MOCK_LOGIN_RESPONSE.profile.profile_id,
    },
  },
});

describe('authentication/authentication-controller - constructor() tests', () => {
  test('should initialize with default state', () => {
    const metametrics = createMockAuthMetaMetrics();
    const controller = new AuthenticationController({
      messenger: createMockAuthenticationMessenger().messenger,
      metametrics,
    });

    expect(controller.state.isSignedIn).toBe(false);
    expect(controller.state.sessionData).toBeUndefined();
  });

  test('should initialize with override state', () => {
    const metametrics = createMockAuthMetaMetrics();
    const controller = new AuthenticationController({
      messenger: createMockAuthenticationMessenger().messenger,
      state: mockSignedInState(),
      metametrics,
    });

    expect(controller.state.isSignedIn).toBe(true);
    expect(controller.state.sessionData).toBeDefined();
  });
});

describe('authentication/authentication-controller - performSignIn() tests', () => {
  test('Should create access token and update state', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const mockEndpoints = mockAuthenticationFlowEndpoints();
    const { messenger, mockSnapGetPublicKey, mockSnapSignMessage } =
      createMockAuthenticationMessenger();

    const controller = new AuthenticationController({ messenger, metametrics });

    const result = await controller.performSignIn();
    expect(mockSnapGetPublicKey).toBeCalled();
    expect(mockSnapSignMessage).toBeCalled();
    mockEndpoints.mockGetNonceEndpoint.done();
    mockEndpoints.mockLoginEndpoint.done();
    mockEndpoints.mockAccessTokenEndpoint.done();
    expect(result).toBe(MOCK_ACCESS_TOKEN);

    // Assert - state shows user is logged in
    expect(controller.state.isSignedIn).toBe(true);
    expect(controller.state.sessionData).toBeDefined();
  });

  test('Should error when nonce endpoint fails', async () => {
    await testAndAssertFailingEndpoints('nonce');
  });

  test('Should error when login endpoint fails', async () => {
    await testAndAssertFailingEndpoints('login');
  });

  test('Should error when tokens endpoint fails', async () => {
    await testAndAssertFailingEndpoints('token');
  });

  // When the wallet is locked, we are unable to call the snap
  test('Should error when wallet is locked', async () => {
    const { messenger, mockKeyringControllerGetState } =
      createMockAuthenticationMessenger();
    const metametrics = createMockAuthMetaMetrics();

    // Mock wallet is locked
    mockKeyringControllerGetState.mockReturnValue({ isUnlocked: false });

    const controller = new AuthenticationController({ messenger, metametrics });

    await expect(controller.performSignIn()).rejects.toThrow();
  });

  async function testAndAssertFailingEndpoints(
    endpointFail: 'nonce' | 'login' | 'token',
  ) {
    const mockEndpoints = mockAuthenticationFlowEndpoints({
      endpointFail,
    });
    const { messenger } = createMockAuthenticationMessenger();
    const metametrics = createMockAuthMetaMetrics();
    const controller = new AuthenticationController({ messenger, metametrics });

    await expect(controller.performSignIn()).rejects.toThrow();
    expect(controller.state.isSignedIn).toBe(false);

    const endpointsCalled = [
      mockEndpoints.mockGetNonceEndpoint.isDone(),
      mockEndpoints.mockLoginEndpoint.isDone(),
      mockEndpoints.mockAccessTokenEndpoint.isDone(),
    ];
    if (endpointFail === 'nonce') {
      expect(endpointsCalled).toEqual([true, false, false]);
    }

    if (endpointFail === 'login') {
      expect(endpointsCalled).toEqual([true, true, false]);
    }

    if (endpointFail === 'token') {
      expect(endpointsCalled).toEqual([true, true, true]);
    }
  }
});

describe('authentication/authentication-controller - performSignOut() tests', () => {
  test('Should remove signed in user and any access tokens', () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    const controller = new AuthenticationController({
      messenger,
      state: mockSignedInState(),
      metametrics,
    });

    controller.performSignOut();
    expect(controller.state.isSignedIn).toBe(false);
    expect(controller.state.sessionData).toBeUndefined();
  });

  test('Should throw error if attempting to sign out when user is not logged in', () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    const controller = new AuthenticationController({
      messenger,
      state: { isSignedIn: false },
      metametrics,
    });

    expect(() => controller.performSignOut()).toThrow();
  });
});

describe('authentication/authentication-controller - getBearerToken() tests', () => {
  test('Should throw error if not logged in', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    const controller = new AuthenticationController({
      messenger,
      state: { isSignedIn: false },
      metametrics,
    });

    await expect(controller.getBearerToken()).rejects.toThrow();
  });

  test('Should return original access token in state', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    const originalState = mockSignedInState();
    const controller = new AuthenticationController({
      messenger,
      state: originalState,
      metametrics,
    });

    const result = await controller.getBearerToken();
    expect(result).toBeDefined();
    expect(result).toBe(originalState.sessionData?.accessToken);
  });

  test('Should return new access token if state is invalid', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    mockAuthenticationFlowEndpoints();

    // Invalid/old state
    const originalState = mockSignedInState();
    if (originalState.sessionData) {
      originalState.sessionData.accessToken = 'ACCESS_TOKEN_1';

      const d = new Date();
      d.setMinutes(d.getMinutes() - 31); // expires at 30 mins
      originalState.sessionData.expiresIn = d.toString();
    }

    const controller = new AuthenticationController({
      messenger,
      state: originalState,
      metametrics,
    });

    const result = await controller.getBearerToken();
    expect(result).toBeDefined();
    expect(result).toBe(MOCK_ACCESS_TOKEN);
  });

  // If the state is invalid, we need to re-login.
  // But as wallet is locked, we will not be able to call the snap
  test('Should throw error if wallet is locked', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger, mockKeyringControllerGetState } =
      createMockAuthenticationMessenger();
    mockAuthenticationFlowEndpoints();

    // Invalid/old state
    const originalState = mockSignedInState();
    if (originalState.sessionData) {
      originalState.sessionData.accessToken = 'ACCESS_TOKEN_1';

      const d = new Date();
      d.setMinutes(d.getMinutes() - 31); // expires at 30 mins
      originalState.sessionData.expiresIn = d.toString();
    }

    // Mock wallet is locked
    mockKeyringControllerGetState.mockReturnValue({ isUnlocked: false });

    const controller = new AuthenticationController({
      messenger,
      state: originalState,
      metametrics,
    });

    await expect(controller.getBearerToken()).rejects.toThrow();
  });
});

describe('authentication/authentication-controller - getSessionProfile() tests', () => {
  test('Should throw error if not logged in', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    const controller = new AuthenticationController({
      messenger,
      state: { isSignedIn: false },
      metametrics,
    });

    await expect(controller.getSessionProfile()).rejects.toThrow();
  });

  test('Should return original access token in state', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    const originalState = mockSignedInState();
    const controller = new AuthenticationController({
      messenger,
      state: originalState,
      metametrics,
    });

    const result = await controller.getSessionProfile();
    expect(result).toBeDefined();
    expect(result).toEqual(originalState.sessionData?.profile);
  });

  test('Should return new access token if state is invalid', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger } = createMockAuthenticationMessenger();
    mockAuthenticationFlowEndpoints();

    // Invalid/old state
    const originalState = mockSignedInState();
    if (originalState.sessionData) {
      originalState.sessionData.profile.identifierId = 'ID_1';

      const d = new Date();
      d.setMinutes(d.getMinutes() - 31); // expires at 30 mins
      originalState.sessionData.expiresIn = d.toString();
    }

    const controller = new AuthenticationController({
      messenger,
      state: originalState,
      metametrics,
    });

    const result = await controller.getSessionProfile();
    expect(result).toBeDefined();
    expect(result.identifierId).toBe(MOCK_LOGIN_RESPONSE.profile.identifier_id);
    expect(result.profileId).toBe(MOCK_LOGIN_RESPONSE.profile.profile_id);
  });

  // If the state is invalid, we need to re-login.
  // But as wallet is locked, we will not be able to call the snap
  test('Should throw error if wallet is locked', async () => {
    const metametrics = createMockAuthMetaMetrics();
    const { messenger, mockKeyringControllerGetState } =
      createMockAuthenticationMessenger();
    mockAuthenticationFlowEndpoints();

    // Invalid/old state
    const originalState = mockSignedInState();
    if (originalState.sessionData) {
      originalState.sessionData.profile.identifierId = 'ID_1';

      const d = new Date();
      d.setMinutes(d.getMinutes() - 31); // expires at 30 mins
      originalState.sessionData.expiresIn = d.toString();
    }

    // Mock wallet is locked
    mockKeyringControllerGetState.mockReturnValue({ isUnlocked: false });

    const controller = new AuthenticationController({
      messenger,
      state: originalState,
      metametrics,
    });

    await expect(controller.getSessionProfile()).rejects.toThrow();
  });
});

function createAuthenticationMessenger() {
  const messenger = new ControllerMessenger<AllowedActions, AllowedEvents>();
  return messenger.getRestricted({
    name: 'AuthenticationController',
    allowedActions: [
      `SnapController:handleRequest`,
      'KeyringController:getState',
    ],
    allowedEvents: ['KeyringController:lock', 'KeyringController:unlock'],
  });
}

function createMockAuthenticationMessenger() {
  const messenger = createAuthenticationMessenger();
  const mockCall = jest.spyOn(messenger, 'call');
  const mockSnapGetPublicKey = jest.fn().mockResolvedValue('MOCK_PUBLIC_KEY');
  const mockSnapSignMessage = jest
    .fn()
    .mockResolvedValue('MOCK_SIGNED_MESSAGE');

  const mockKeyringControllerGetState = jest
    .fn()
    .mockReturnValue({ isUnlocked: true });

  mockCall.mockImplementation((...args) => {
    const [actionType, params] = args;
    if (actionType === 'SnapController:handleRequest') {
      if (params?.request.method === 'getPublicKey') {
        return mockSnapGetPublicKey();
      }

      if (params?.request.method === 'signMessage') {
        return mockSnapSignMessage();
      }

      throw new Error(
        `MOCK_FAIL - unsupported SnapController:handleRequest call: ${params?.request.method}`,
      );
    }

    if (actionType === 'KeyringController:getState') {
      return mockKeyringControllerGetState();
    }

    throw new Error(`MOCK_FAIL - unsupported messenger call: ${actionType}`);
  });

  return {
    messenger,
    mockSnapGetPublicKey,
    mockSnapSignMessage,
    mockKeyringControllerGetState,
  };
}

function mockAuthenticationFlowEndpoints(params?: {
  endpointFail: 'nonce' | 'login' | 'token';
}) {
  const mockGetNonceEndpoint = mockEndpointGetNonce(
    params?.endpointFail === 'nonce' ? { status: 500 } : undefined,
  );
  const mockLoginEndpoint = mockEndpointLogin(
    params?.endpointFail === 'login' ? { status: 500 } : undefined,
  );
  const mockAccessTokenEndpoint = mockEndpointAccessToken(
    params?.endpointFail === 'token' ? { status: 500 } : undefined,
  );

  return {
    mockGetNonceEndpoint,
    mockLoginEndpoint,
    mockAccessTokenEndpoint,
  };
}

function createMockAuthMetaMetrics() {
  const getMetaMetricsId = jest.fn().mockReturnValue('MOCK_METAMETRICS_ID');

  return { getMetaMetricsId };
}
