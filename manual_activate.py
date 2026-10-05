from local_node.activation import activate_with_token

API_BASE_URL = "http://127.0.0.1:5000"
INSTALL_TOKEN = "qia_install_00wqH-4pkJFCMElJCGPOuL48Xr00XMFPuCdm3kk90L8"
NODE_LABEL = "Branch-2 Node"

if __name__ == "__main__":
    result = activate_with_token(API_BASE_URL, INSTALL_TOKEN, NODE_LABEL)
    print("Activated:", result)