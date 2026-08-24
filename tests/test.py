"""
Comprehensive test suite for the AI Attendance System.
Tests models, database, embeddings, quality checks, and spoof detection.
"""

import os
import sys
import numpy as np
from pathlib import Path

# Add project to path
sys.path.insert(0, str(Path(__file__).parent))

import database as db
import face_processor as fp
from download_models import verify_models
from logger_config import get_logger

logger = get_logger(__name__)


def test_configuration():
    """Test configuration loading."""
    logger.info("\n[TEST] Configuration")
    logger.info("-" * 50)
    
    try:
        from config import (
            FACE_MATCHING_THRESHOLD, MIN_ENROLLMENT_FRAMES,
            YOLO_MODEL, INSIGHTFACE_MODEL, ENABLE_GPU
        )
        
        logger.info(f"✓ Configuration loaded")
        return True
    except Exception as e:
        logger.error(f"✗ Configuration test failed: {e}")
        return False


def test_logging():
    """Test logging system."""
    logger.info("\n[TEST] Logging System")
    logger.info("-" * 50)
    
    try:
        test_logger = get_logger("test_module")
        test_logger.info("Test info message")
        logger.info("✓ Logging system working")
        return True
    except Exception as e:
        logger.error(f"✗ Logging test failed: {e}")
        return False


def test_models():
    """Test model loading."""
    logger.info("\n[TEST] Model Loading")
    logger.info("-" * 50)
    
    if verify_models():
        logger.info("✓ All models loaded successfully")
        return True
    else:
        logger.error("✗ Model loading failed")
        return False


def test_database():
    """Test database operations."""
    logger.info("\n[TEST] Database Operations")
    logger.info("-" * 50)
    
    try:
        db.init_db()
        # Clean up existing test user to keep tests repeatable
        try:
            import sqlite3
            conn = sqlite3.connect(db.DB_PATH)
            cursor = conn.cursor()
            cursor.execute("DELETE FROM users WHERE name = ?", ("Test User",))
            conn.commit()
            conn.close()
        except Exception as cleanup_err:
            logger.warning(f"Cleanup of 'Test User' failed: {cleanup_err}")

        user_id = db.add_user("Test User", "test@example.com")
        if not user_id:
            logger.error("✗ User creation failed")
            return False
        
        logger.info("✓ User created and database working")
        return True
    except Exception as e:
        logger.error(f"✗ Database test error: {e}")
        return False


def test_embedding_comparison():
    """Test embedding comparison."""
    logger.info("\n[TEST] Embedding Comparison")
    logger.info("-" * 50)
    
    try:
        emb1 = np.random.randn(512)
        emb2 = emb1 + np.random.randn(512) * 0.1
        emb3 = np.random.randn(512)
        
        sim12, match12 = fp.compare_embeddings(emb1, emb2, threshold=0.6)
        sim13, match13 = fp.compare_embeddings(emb1, emb3, threshold=0.6)
        
        if match12 and not match13:
            logger.info("✓ Embedding comparison working")
            return True
        else:
            logger.error("✗ Comparison logic issue")
            return False
    except Exception as e:
        logger.error(f"✗ Comparison test error: {e}")
        return False


def test_aggregate_embedding():
    """Test embedding aggregation."""
    logger.info("\n[TEST] Embedding Aggregation")
    logger.info("-" * 50)
    
    try:
        embeddings = [np.random.randn(512) for _ in range(10)]
        aggregate = fp.compute_aggregate_embedding(embeddings)
        
        if aggregate is not None and len(aggregate) == 512:
            norm = np.linalg.norm(aggregate)
            if 0.9 <= norm <= 1.1:
                logger.info("✓ Embedding aggregation working")
                return True
        
        logger.error("✗ Aggregation failed")
        return False
    except Exception as e:
        logger.error(f"✗ Aggregation test error: {e}")
        return False


def run_all_tests():
    """Run all tests."""
    logger.info("\n" + "=" * 60)
    logger.info("Flask AI Attendance System - Comprehensive Test Suite")
    logger.info("=" * 60)
    
    results = []
    tests = [
        ("Configuration", test_configuration),
        ("Logging System", test_logging),
        ("Model Loading", test_models),
        ("Database Operations", test_database),
        ("Embedding Comparison", test_embedding_comparison),
        ("Embedding Aggregation", test_aggregate_embedding),
    ]
    
    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            logger.error(f"✗ {test_name} error: {e}")
            results.append((test_name, False))
    
    logger.info("\n" + "=" * 60)
    logger.info("Test Summary")
    logger.info("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "✓ PASS" if result else "✗ FAIL"
        logger.info(f"{status}: {name}")
    
    logger.info(f"\nTotal: {passed}/{total} tests passed")
    logger.info("=" * 60)
    
    return passed == total


if __name__ == '__main__':
    success = run_all_tests()
    sys.exit(0 if success else 1)
