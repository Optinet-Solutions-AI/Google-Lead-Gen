from flask import Flask, request, jsonify
import logging
from datetime import datetime

app = Flask(__name__)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "timestamp": datetime.now().isoformat()})

@app.route('/webhook/n8n', methods=['POST'])
def receive_n8n_message():
    """Receive messages from n8n"""
    try:
        data = request.json
        
        # Log incoming message
        logging.info(f"Received message from n8n: {data}")
        
        # Extract message content
        message = data.get('message', '')
        session_id = data.get('session_id', 'default')
        metadata = data.get('metadata', {})
        
        # TODO: Add your OpenClaw processing logic here
        # For now, we'll just acknowledge receipt
        response = process_with_openclaw(message, session_id, metadata)
        
        return jsonify({
            "status": "success",
            "message_received": message,
            "session_id": session_id,
            "response": response,
            "timestamp": datetime.now().isoformat()
        }), 200
        
    except Exception as e:
        logging.error(f"Error processing webhook: {str(e)}")
        return jsonify({
            "status": "error",
            "error": str(e)
        }), 500

def process_with_openclaw(message, session_id, metadata):
    """
    Process the message with OpenClaw
    Replace this with your actual OpenClaw integration
    """
    # Example: Send to OpenClaw chat interface
    # openclaw_client.send_message(message, session_id)
    
    # For now, return a placeholder
    return f"Processed: {message}"

if __name__ == '__main__':
    # Run on all interfaces, port 5000
    app.run(host='0.0.0.0', port=5000, debug=False)
